import { asyncExecShell, getEngine } from '$lib/common';
import { dockerInstance } from '$lib/docker';
import { startNTACloudProxy } from '$lib/haproxy';
import { getDatabaseImage } from '.';
import { prisma } from './common';
import type { DestinationDocker, Service, Application, Prisma } from '@prisma/client';
import type { CreateDockerDestination } from '$lib/types/destinations';

type DestinationConfigurationObject = {
	id: string;
	destinationId: string;
};

type FindDestinationFromTeam = {
	id: string;
	teamId: string;
};

export async function listDestinations(teamId: string): Promise<DestinationDocker[]> {
	if (teamId === '0') {
		return await prisma.destinationDocker.findMany({ include: { teams: true } });
	}
	return await prisma.destinationDocker.findMany({
		where: { teams: { some: { id: teamId } } },
		include: { teams: true }
	});
}

export async function configureDestinationForService({
	id,
	destinationId
}: DestinationConfigurationObject): Promise<Service> {
	return await prisma.service.update({
		where: { id },
		data: { destinationDocker: { connect: { id: destinationId } } }
	});
}
export async function configureDestinationForApplication({
	id,
	destinationId
}: DestinationConfigurationObject): Promise<Application> {
	return await prisma.application.update({
		where: { id },
		data: { destinationDocker: { connect: { id: destinationId } } }
	});
}
export async function configureDestinationForDatabase({
	id,
	destinationId
}: DestinationConfigurationObject): Promise<void> {
	await prisma.database.update({
		where: { id },
		data: { destinationDocker: { connect: { id: destinationId } } }
	});

	const {
		destinationDockerId,
		destinationDocker: { engine },
		version,
		type
	} = await prisma.database.findUnique({ where: { id }, include: { destinationDocker: true } });

	if (destinationDockerId) {
		const host = getEngine(engine);
		if (type && version) {
			const baseImage = getDatabaseImage(type);
			asyncExecShell(`DOCKER_HOST=${host} docker pull ${baseImage}:${version}`);
		}
	}
}
export async function updateDestination({
	id,
	name,
	engine,
	network
}: Pick<DestinationDocker, 'id' | 'name' | 'engine' | 'network'>): Promise<DestinationDocker> {
	return await prisma.destinationDocker.update({ where: { id }, data: { name, engine, network } });
}

export async function newRemoteDestination({
	name,
	teamId,
	engine,
	network,
	isNTACloudProxyUsed,
	remoteEngine
}: CreateDockerDestination): Promise<string> {
	const destination = await prisma.destinationDocker.create({
		data: {
			name,
			teams: { connect: { id: teamId } },
			engine,
			network,
			isNTACloudProxyUsed,
			remoteEngine
		}
	});
	return destination.id;
}
export async function newLocalDestination({
	name,
	teamId,
	engine,
	network,
	isNTACloudProxyUsed
}: CreateDockerDestination): Promise<string> {
	const host = getEngine(engine);
	const docker = dockerInstance({ destinationDocker: { engine, network } });
	const found = await docker.engine.listNetworks({ filters: { name: [`^${network}$`] } });
	if (found.length === 0) {
		await asyncExecShell(`DOCKER_HOST=${host} docker network create --attachable ${network}`);
	}
	await prisma.destinationDocker.create({
		data: { name, teams: { connect: { id: teamId } }, engine, network, isNTACloudProxyUsed }
	});
	const destinations = await prisma.destinationDocker.findMany({ where: { engine } });
	const destination = destinations.find((destination) => destination.network === network);

	if (destinations.length > 0) {
		const proxyConfigured = destinations.find(
			(destination) => destination.network !== network && destination.isNTACloudProxyUsed === true
		);
		if (proxyConfigured) {
			isNTACloudProxyUsed = !!proxyConfigured.isNTACloudProxyUsed;
		}
		await prisma.destinationDocker.updateMany({ where: { engine }, data: { isNTACloudProxyUsed } });
	}
	if (isNTACloudProxyUsed) await startNTACloudProxy(engine);
	return destination.id;
}
export async function removeDestination({ id }: Pick<DestinationDocker, 'id'>): Promise<void> {
	const destination = await prisma.destinationDocker.delete({ where: { id } });
	if (destination.isNTACloudProxyUsed) {
		const host = getEngine(destination.engine);
		const { network } = destination;
		const { stdout: found } = await asyncExecShell(
			`DOCKER_HOST=${host} docker ps -a --filter network=${network} --filter name=ntacloud-haproxy --format '{{.}}'`
		);
		if (found) {
			await asyncExecShell(
				`DOCKER_HOST="${host}" docker network disconnect ${network} ntacloud-haproxy`
			);
			await asyncExecShell(`DOCKER_HOST="${host}" docker network rm ${network}`);
		}
	}
}

export async function getDestination({
	id,
	teamId
}: FindDestinationFromTeam): Promise<DestinationDocker & { sshPrivateKey?: string }> {
	let destination;
	if (teamId === '0') {
		destination = await prisma.destinationDocker.findFirst({
			where: { id }
		});
	} else {
		destination = await prisma.destinationDocker.findFirst({
			where: { id, teams: { some: { id: teamId } } }
		});
	}

	return destination;
}
export async function getDestinationByApplicationId({
	id,
	teamId
}: FindDestinationFromTeam): Promise<DestinationDocker> {
	return await prisma.destinationDocker.findFirst({
		where: { application: { some: { id } }, teams: { some: { id: teamId } } }
	});
}

export async function setDestinationSettings({
	engine,
	isNTACloudProxyUsed
}: {
	engine: string;
	isNTACloudProxyUsed: boolean;
}): Promise<Prisma.BatchPayload> {
	return await prisma.destinationDocker.updateMany({
		where: { engine },
		data: { isNTACloudProxyUsed }
	});
}
