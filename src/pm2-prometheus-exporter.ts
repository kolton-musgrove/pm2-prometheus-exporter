import pm2 from 'pm2';
import client from 'prom-client';

// for all pm2 implementation documentation see https://pm2.keymetrics.io/docs/usage/pm2-api/

/**
 * @interface ProcessPacket
 * @description
 * This interface is used to define the structure of the packets sent between processes
 * @property {string} topic the message topic
 * @property {number} id the pm2 proc id the message is currently on
 * @property {any} data the payload of this packet
 * @property {boolean} isReply is this a reply
 * @property {number} replyTo the pm2 proc id expecting the reply
 * @property {number} originalProcId the originating proc id
 */
interface ProcessPacket {
  topic: string;
  id: number;
  data: any;
  isReply?: boolean;
  replyTo?: number;
  originalProcId: number;
}

export const isClusterMode = process.env.exec_mode === 'cluster_mode';

/**
 * Returns the current process id
 * @returns {number} the current process id
 */
function getCurrentProcId(): number {
  if (process.env.pm_id === undefined) {
    throw new Error('PM2 process id not found');
  }

  return parseInt(process.env.pm_id, 10);
}

/**
 * @function getProcList
 * @description
 * Returns a list of PM2 processes when running in clustered mode
 * @returns {Promise<Array<pm2.ProcessDescription>>} a promise that resolves with an array of PM2 process descriptions
 */
function getProcList(): Promise<Array<pm2.ProcessDescription>> {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => {
      err
        ? reject(err)
        : // only return processes with the same name
          resolve(
            list.filter(
              (o) =>
                o.name === process.env.name &&
                o.pm2_env &&
                o.pm2_env.status === 'online',
            ),
          );
    });
  });
}

/**
 * Broadcasts message to all processes in the cluster,
 * resolving with the number of processes sent to
 * @param {ProcessPacket} packet
 * @returns {Promise<number>}
 */
async function broadcastToAll(packet: ProcessPacket): Promise<number> {
  const procList = await getProcList();

  procList.forEach((proc) => {
    if (proc.pm_id) {
      pm2.sendDataToProcessId(proc.pm_id, packet, (err) => true);
    }
  });

  return procList.length;
}

/**
 * Sends a message to all processes in the cluster and resolves
 * once all processes have responded or after a timeout
 * @param {string} topic
 * @param {number} timeoutInMilliseconds
 * @returns {Promise<Array<ProcessPacket>>}
 */
function awaitAllProcMessagesReplies(
  topic: string,
  timeoutInMilliseconds: number,
): Promise<Array<ProcessPacket>> {
  return new Promise(async (resolve, reject) => {
    const responses: ProcessPacket[] = [];
    const currentProcId = getCurrentProcId();

    const procLength = await broadcastToAll({
      id: currentProcId,
      replyTo: currentProcId,
      originalProcId: currentProcId,
      topic,
      data: {},
      isReply: false,
    });

    const timeoutHandle = setTimeout(
      () => reject('timeout'),
      timeoutInMilliseconds,
    );

    const handler = (response: ProcessPacket) => {
      if (!response.isReply || response.topic !== topic) return;

      responses.push(response);

      if (responses.length === procLength) {
        process.removeListener('message', handler);
        clearTimeout(timeoutHandle);
        resolve(responses);
      }
    };

    process.on('message', handler);
  });
}

/**
 * Sends a reply to the process which originated a broadcast
 * @param {ProcessPacket} originalPacket the original packet received
 * @param {any} data the optional data to respond with
 * @returns {void}
 * @throws {Error}
 */
function sendProcReply(originalPacket: ProcessPacket, data: any = {}) {
  const currentProcId = getCurrentProcId();

  const returnPacket: ProcessPacket = {
    ...originalPacket,
    data,
    isReply: true,
    id: currentProcId,
    originalProcId: currentProcId,
  };

  if (originalPacket.replyTo === undefined) {
    throw new Error('ReplyTo is undefined');
  }

  pm2.sendDataToProcessId(originalPacket.replyTo, returnPacket, (err) => true);
}

/**
 * Returns aggregate metrics if running in cluster mode,
 * otherwise, just the current instance's metrics
 * @param timeoutInMilliseconds  how long to wait for other processes to provide their metrics
 * @returns
 */
export async function getAggregateMetrics(
  timeoutInMilliseconds: number = 10e3,
): Promise<client.Registry> {
  if (isClusterMode) {
    const procMetrics = await awaitAllProcMessagesReplies(
      'metrics-get',
      timeoutInMilliseconds,
    );

    return client.AggregatorRegistry.aggregate(procMetrics.map((o) => o.data));
  } else {
    return client.register;
  }
}

/**
 * Creates a timer which executes a callback at the next sync time
 * @param {number} syncTimeInMilliseconds time in milliseconds to sync to
 * @param {() => void} callback the callback to execute
 * @returns {NodeJS.Timer} the timer handle
 */
export function timeSyncRun(
  syncTimeInMilliseconds: number,
  callback: () => void,
): NodeJS.Timer {
  const handle = setTimeout(
    callback,
    syncTimeInMilliseconds - (Date.now() % syncTimeInMilliseconds),
  );

  handle.unref();
  return handle;
}

if (isClusterMode) {
  const handleProcessMessage = async (packet: ProcessPacket) => {
    if (packet && packet.topic === 'metrics-get' && !packet.isReply) {
      sendProcReply(packet, await client.register.getMetricsAsJSON());
    }
  };

  process.removeListener('message', handleProcessMessage);
  process.on('message', handleProcessMessage);
}
