import * as Bullmq from 'bullmq';
import { default as ProdBullmq, QueueScheduler } from 'bullmq';
import { dev } from '$app/env';
import { prisma } from '$lib/database';

import builder from './builder';
import logger from './logger';
import cleanup from './cleanup';
import proxy from './proxy';
import proxyTcpHttp from './proxyTcpHttp';
import ssl from './ssl';
import sslrenewal from './sslrenewal';

import { asyncExecShell, saveBuildLog } from '$lib/common';

let { Queue, Worker } = Bullmq;
let redisHost = 'localhost';

if (!dev) {
	Queue = ProdBullmq.Queue;
	Worker = ProdBullmq.Worker;
	redisHost = 'ntacloud-redis';
}

const connectionOptions = {
	connection: {
		host: redisHost
	}
};

const cron = async (): Promise<void> => {
	new QueueScheduler('proxy', connectionOptions);
	new QueueScheduler('proxyTcpHttp', connectionOptions);
	new QueueScheduler('cleanup', connectionOptions);
	new QueueScheduler('ssl', connectionOptions);
	new QueueScheduler('sslRenew', connectionOptions);

	const queue = {
		proxy: new Queue('proxy', { ...connectionOptions }),
		proxyTcpHttp: new Queue('proxyTcpHttp', { ...connectionOptions }),
		cleanup: new Queue('cleanup', { ...connectionOptions }),
		ssl: new Queue('ssl', { ...connectionOptions }),
		sslRenew: new Queue('sslRenew', { ...connectionOptions })
	};
	await queue.proxy.drain();
	await queue.proxyTcpHttp.drain();
	await queue.cleanup.drain();
	await queue.ssl.drain();
	await queue.sslRenew.drain();

	new Worker(
		'proxy',
		async () => {
			await proxy();
		},
		{
			...connectionOptions
		}
	);

	new Worker(
		'proxyTcpHttp',
		async () => {
			await proxyTcpHttp();
		},
		{
			...connectionOptions
		}
	);

	new Worker(
		'ssl',
		async () => {
			await ssl();
		},
		{
			...connectionOptions
		}
	);

	new Worker(
		'cleanup',
		async () => {
			await cleanup();
		},
		{
			...connectionOptions
		}
	);

	new Worker(
		'sslRenew',
		async () => {
			await sslrenewal();
		},
		{
			...connectionOptions
		}
	);

	await queue.proxy.add('proxy', {}, { repeat: { every: 10000 } });
	await queue.proxyTcpHttp.add('proxyTcpHttp', {}, { repeat: { every: 10000 } });
	await queue.ssl.add('ssl', {}, { repeat: { every: dev ? 10000 : 60000 } });
	if (!dev) await queue.cleanup.add('cleanup', {}, { repeat: { every: 300000 } });
	await queue.sslRenew.add('sslRenew', {}, { repeat: { every: 1800000 } });
};
cron().catch((error) => {
	console.log('cron failed to start');
	console.log(error);
});

const buildQueueName = 'build_queue';
const buildQueue = new Queue(buildQueueName, connectionOptions);
const buildWorker = new Worker(buildQueueName, async (job) => await builder(job), {
	concurrency: 1,
	...connectionOptions
});

buildWorker.on('completed', async (job: Bullmq.Job) => {
	try {
		await prisma.build.update({ where: { id: job.data.build_id }, data: { status: 'success' } });
	} catch (error) {
		setTimeout(async () => {
			await prisma.build.update({ where: { id: job.data.build_id }, data: { status: 'success' } });
		}, 1234);
		console.log(error);
	} finally {
		const workdir = `/tmp/build-sources/${job.data.repository}/${job.data.build_id}`;
		if (!dev) await asyncExecShell(`rm -fr ${workdir}`);
		await prisma.build.update({ where: { id: job.data.build_id }, data: { status: 'success' } });
	}
	return;
});

buildWorker.on('failed', async (job: Bullmq.Job, failedReason) => {
	try {
		await prisma.build.update({ where: { id: job.data.build_id }, data: { status: 'failed' } });
	} catch (error) {
		setTimeout(async () => {
			await prisma.build.update({ where: { id: job.data.build_id }, data: { status: 'failed' } });
		}, 1234);
		console.log(error);
	} finally {
		const workdir = `/tmp/build-sources/${job.data.repository}`;
		if (!dev) await asyncExecShell(`rm -fr ${workdir}`);
		await prisma.build.update({ where: { id: job.data.build_id }, data: { status: 'failed' } });
	}
	await saveBuildLog({
		line: 'Failed to deploy!',
		buildId: job.data.build_id,
		applicationId: job.data.id
	});
	await saveBuildLog({
		line: `Reason: ${failedReason.toString()}`,
		buildId: job.data.build_id,
		applicationId: job.data.id
	});
});

const buildLogQueueName = 'log_queue';
const buildLogQueue = new Queue(buildLogQueueName, connectionOptions);
const buildLogWorker = new Worker(buildLogQueueName, async (job) => await logger(job), {
	concurrency: 1,
	...connectionOptions
});

export { buildQueue, buildLogQueue };
