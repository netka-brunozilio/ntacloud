import { dev } from '$app/env';
import { asyncExecShell, getEngine } from '$lib/common';
import got, { type Got, type Response } from 'got';
import * as db from '$lib/database';
import type { DestinationDocker } from '@prisma/client';

const url = dev ? 'http://localhost:5555' : 'http://ntacloud-haproxy:5555';

export const defaultProxyImage = `ntacloud-haproxy-alpine:latest`;
export const defaultProxyImageTcp = `ntacloud-haproxy-tcp-alpine:latest`;
export const defaultProxyImageHttp = `ntacloud-haproxy-http-alpine:latest`;

export async function haproxyInstance(): Promise<Got> {
	const { proxyPassword } = await db.listSettings();
	return got.extend({
		prefixUrl: url,
		username: 'admin',
		password: proxyPassword
	});
}

export async function getRawConfiguration(): Promise<RawHaproxyConfiguration> {
	return await (await haproxyInstance()).get(`v2/services/haproxy/configuration/raw`).json();
}

export async function getNextTransactionVersion(): Promise<number> {
	const raw = await getRawConfiguration();
	if (raw?._version) {
		return raw._version;
	}
	return 1;
}

export async function getNextTransactionId(): Promise<string> {
	const version = await getNextTransactionVersion();
	const newTransaction: NewTransaction = await (
		await haproxyInstance()
	)
		.post('v2/services/haproxy/transactions', {
			searchParams: {
				version
			}
		})
		.json();
	return newTransaction.id;
}

export async function completeTransaction(transactionId: string): Promise<Response<string>> {
	const haproxy = await haproxyInstance();
	return await haproxy.put(`v2/services/haproxy/transactions/${transactionId}`);
}

export async function deleteProxy({ id }: { id: string }): Promise<void> {
	const haproxy = await haproxyInstance();
	await checkHAProxy(haproxy);

	let transactionId;
	try {
		await haproxy.get(`v2/services/haproxy/configuration/backends/${id}`).json();
		transactionId = await getNextTransactionId();
		await haproxy
			.delete(`v2/services/haproxy/configuration/backends/${id}`, {
				searchParams: {
					transaction_id: transactionId
				}
			})
			.json();
		await haproxy.get(`v2/services/haproxy/configuration/frontends/${id}`).json();
		await haproxy
			.delete(`v2/services/haproxy/configuration/frontends/${id}`, {
				searchParams: {
					transaction_id: transactionId
				}
			})
			.json();
	} catch (error) {
		console.log(error.response?.body || error);
	} finally {
		if (transactionId) await completeTransaction(transactionId);
	}
}

export async function reloadHaproxy(engine: string): Promise<{ stdout: string; stderr: string }> {
	const host = getEngine(engine);
	return await asyncExecShell(`DOCKER_HOST=${host} docker exec ntacloud-haproxy kill -HUP 1`);
}

export async function checkHAProxy(haproxy?: Got): Promise<void> {
	if (!haproxy) haproxy = await haproxyInstance();
	try {
		await haproxy.get('v2/info');
	} catch (error) {
		throw {
			message:
				'NTACloud Proxy is not running, but it should be!<br><br>Start it in the "Destinations" menu.'
		};
	}
}

export async function stopTcpHttpProxy(
	destinationDocker: DestinationDocker,
	publicPort: number
): Promise<{ stdout: string; stderr: string } | Error> {
	const { engine } = destinationDocker;
	const host = getEngine(engine);
	const containerName = `haproxy-for-${publicPort}`;
	const found = await checkContainer(engine, containerName);
	try {
		if (found) {
			return await asyncExecShell(
				`DOCKER_HOST=${host} docker stop -t 0 ${containerName} && docker rm ${containerName}`
			);
		}
	} catch (error) {
		return error;
	}
}
export async function startTcpProxy(
	destinationDocker: DestinationDocker,
	id: string,
	publicPort: number,
	privatePort: number,
	volume?: string
): Promise<{ stdout: string; stderr: string } | Error> {
	const { network, engine } = destinationDocker;
	const host = getEngine(engine);

	const containerName = `haproxy-for-${publicPort}`;
	const found = await checkContainer(engine, containerName);
	const foundDependentContainer = await checkContainer(engine, id);

	try {
		if (foundDependentContainer && !found) {
			const { stdout: Config } = await asyncExecShell(
				`DOCKER_HOST="${host}" docker network inspect bridge --format '{{json .IPAM.Config }}'`
			);
			const ip = JSON.parse(Config)[0].Gateway;
			return await asyncExecShell(
				`DOCKER_HOST=${host} docker run --restart always -e PORT=${publicPort} -e APP=${id} -e PRIVATE_PORT=${privatePort} --add-host 'host.docker.internal:host-gateway' --add-host 'host.docker.internal:${ip}' --network ${network} -p ${publicPort}:${publicPort} --name ${containerName} ${
					volume ? `-v ${volume}` : ''
				} -d netka/${defaultProxyImageTcp}`
			);
		}
		if (!foundDependentContainer && found) {
			return await asyncExecShell(
				`DOCKER_HOST=${host} docker stop -t 0 ${containerName} && docker rm ${containerName}`
			);
		}
	} catch (error) {
		return error;
	}
}

export async function startHttpProxy(
	destinationDocker: DestinationDocker,
	id: string,
	publicPort: number,
	privatePort: number
): Promise<{ stdout: string; stderr: string } | Error> {
	const { network, engine } = destinationDocker;
	const host = getEngine(engine);

	const containerName = `haproxy-for-${publicPort}`;
	const found = await checkContainer(engine, containerName);
	const foundDependentContainer = await checkContainer(engine, id);

	try {
		if (foundDependentContainer && !found) {
			const { stdout: Config } = await asyncExecShell(
				`DOCKER_HOST="${host}" docker network inspect bridge --format '{{json .IPAM.Config }}'`
			);
			const ip = JSON.parse(Config)[0].Gateway;
			return await asyncExecShell(
				`DOCKER_HOST=${host} docker run --restart always -e PORT=${publicPort} -e APP=${id} -e PRIVATE_PORT=${privatePort} --add-host 'host.docker.internal:host-gateway' --add-host 'host.docker.internal:${ip}' --network ${network} -p ${publicPort}:${publicPort} --name ${containerName} -d netka/${defaultProxyImageHttp}`
			);
		}
		if (!foundDependentContainer && found) {
			return await asyncExecShell(
				`DOCKER_HOST=${host} docker stop -t 0 ${containerName} && docker rm ${containerName}`
			);
		}
	} catch (error) {
		return error;
	}
}

export async function startNTACloudProxy(engine: string): Promise<void> {
	const host = getEngine(engine);
	const found = await checkContainer(engine, 'ntacloud-haproxy');
	const { proxyPassword, proxyUser, id } = await db.listSettings();
	if (!found) {
		const { stdout: Config } = await asyncExecShell(
			`DOCKER_HOST="${host}" docker network inspect bridge --format '{{json .IPAM.Config }}'`
		);
		const ip = JSON.parse(Config)[0].Gateway;
		await asyncExecShell(
			`DOCKER_HOST="${host}" docker run -e HAPROXY_USERNAME=${proxyUser} -e HAPROXY_PASSWORD=${proxyPassword} --restart always --add-host 'host.docker.internal:host-gateway' --add-host 'host.docker.internal:${ip}' -v ntacloud-ssl-certs:/usr/local/etc/haproxy/ssl --network ntacloud-infra -p "80:80" -p "443:443" -p "8404:8404" -p "5555:5555" -p "5000:5000" --name ntacloud-haproxy -d netka/${defaultProxyImage}`
		);
		await db.prisma.setting.update({ where: { id }, data: { proxyHash: null } });
	}
	await configureNetworkNTACloudProxy(engine);
}

export async function checkContainer(engine: string, container: string): Promise<boolean> {
	const host = getEngine(engine);
	let containerFound = false;

	try {
		const { stdout } = await asyncExecShell(
			`DOCKER_HOST="${host}" docker inspect --format '{{json .State}}' ${container}`
		);
		const parsedStdout = JSON.parse(stdout);
		const status = parsedStdout.Status;
		const isRunning = status === 'running';
		if (status === 'exited' || status === 'created') {
			await asyncExecShell(`DOCKER_HOST="${host}" docker rm ${container}`);
		}
		if (isRunning) {
			containerFound = true;
		}
	} catch (err) {
		// Container not found
	}
	return containerFound;
}

export async function stopNTACloudProxy(
	engine: string
): Promise<{ stdout: string; stderr: string } | Error> {
	const host = getEngine(engine);
	const found = await checkContainer(engine, 'ntacloud-haproxy');
	await db.setDestinationSettings({ engine, isNTACloudProxyUsed: false });
	const { id } = await db.prisma.setting.findFirst({});
	await db.prisma.setting.update({ where: { id }, data: { proxyHash: null } });
	try {
		if (found) {
			await asyncExecShell(
				`DOCKER_HOST="${host}" docker stop -t 0 ntacloud-haproxy && docker rm ntacloud-haproxy`
			);
		}
	} catch (error) {
		return error;
	}
}

export async function configureNetworkNTACloudProxy(engine: string): Promise<void> {
	const host = getEngine(engine);
	const destinations = await db.prisma.destinationDocker.findMany({ where: { engine } });
	const { stdout: networks } = await asyncExecShell(
		`DOCKER_HOST="${host}" docker ps -a --filter name=ntacloud-haproxy --format '{{json .Networks}}'`
	);
	const configuredNetworks = networks.replace(/"/g, '').replace('\n', '').split(',');
	for (const destination of destinations) {
		if (!configuredNetworks.includes(destination.network)) {
			await asyncExecShell(
				`DOCKER_HOST="${host}" docker network connect ${destination.network} ntacloud-haproxy`
			);
		}
	}
}
