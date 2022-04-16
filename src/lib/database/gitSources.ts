import { decrypt, encrypt } from '$lib/crypto';
import { prisma } from './common';
import type { GithubApp, GitlabApp, GitSource, Prisma, Application } from '@prisma/client';

export async function listSources(
	teamId: string | Prisma.StringFilter
): Promise<(GitSource & { githubApp?: GithubApp; gitlabApp?: GitlabApp })[]> {
	if (teamId === '0') {
		return await prisma.gitSource.findMany({
			include: { githubApp: true, gitlabApp: true, teams: true }
		});
	}
	return await prisma.gitSource.findMany({
		where: { teams: { some: { id: teamId } } },
		include: { githubApp: true, gitlabApp: true, teams: true }
	});
}

export async function newSource({
	name,
	teamId
}: {
	name: string;
	teamId: string;
}): Promise<GitSource> {
	return await prisma.gitSource.create({
		data: {
			name,
			teams: { connect: { id: teamId } }
		}
	});
}
export async function removeSource({ id }: { id: string }): Promise<void> {
	const source = await prisma.gitSource.delete({
		where: { id },
		include: { githubApp: true, gitlabApp: true }
	});
	if (source.githubAppId) await prisma.githubApp.delete({ where: { id: source.githubAppId } });
	if (source.gitlabAppId) await prisma.gitlabApp.delete({ where: { id: source.gitlabAppId } });
}

export async function getSource({
	id,
	teamId
}: {
	id: string;
	teamId: string;
}): Promise<GitSource & { githubApp: GithubApp; gitlabApp: GitlabApp }> {
	let body;
	if (teamId === '0') {
		body = await prisma.gitSource.findFirst({
			where: { id },
			include: { githubApp: true, gitlabApp: true }
		});
	} else {
		body = await prisma.gitSource.findFirst({
			where: { id, teams: { some: { id: teamId } } },
			include: { githubApp: true, gitlabApp: true }
		});
	}
	if (body?.githubApp?.clientSecret)
		body.githubApp.clientSecret = decrypt(body.githubApp.clientSecret);
	if (body?.githubApp?.webhookSecret)
		body.githubApp.webhookSecret = decrypt(body.githubApp.webhookSecret);
	if (body?.githubApp?.privateKey) body.githubApp.privateKey = decrypt(body.githubApp.privateKey);
	if (body?.gitlabApp?.appSecret) body.gitlabApp.appSecret = decrypt(body.gitlabApp.appSecret);
	return body;
}
export async function addGitHubSource({ id, teamId, type, name, htmlUrl, apiUrl, organization }) {
	await prisma.gitSource.update({
		where: { id },
		data: { type, name, htmlUrl, apiUrl, organization }
	});
	return await prisma.githubApp.create({
		data: {
			teams: { connect: { id: teamId } },
			gitSource: { connect: { id } }
		}
	});
}
export async function addGitLabSource({
	id,
	teamId,
	type,
	name,
	htmlUrl,
	apiUrl,
	oauthId,
	appId,
	appSecret,
	groupName
}) {
	const encryptedAppSecret = encrypt(appSecret);
	await prisma.gitSource.update({ where: { id }, data: { type, apiUrl, htmlUrl, name } });
	return await prisma.gitlabApp.create({
		data: {
			teams: { connect: { id: teamId } },
			appId,
			oauthId,
			groupName,
			appSecret: encryptedAppSecret,
			gitSource: { connect: { id } }
		}
	});
}

export async function configureGitsource({
	id,
	gitSourceId
}: {
	id: string;
	gitSourceId: string;
}): Promise<Application> {
	return await prisma.application.update({
		where: { id },
		data: { gitSource: { connect: { id: gitSourceId } } }
	});
}
export async function updateGitsource({
	id,
	name,
	htmlUrl,
	apiUrl
}: {
	id: string;
	name: string;
	htmlUrl: string;
	apiUrl: string;
}): Promise<GitSource> {
	return await prisma.gitSource.update({
		where: { id },
		data: { name, htmlUrl, apiUrl }
	});
}
