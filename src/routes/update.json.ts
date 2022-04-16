import { dev } from '$app/env';
import { asyncExecShell, version } from '$lib/common';
import { asyncSleep } from '$lib/components/common';
import { ErrorHandler } from '$lib/database';
import type { RequestHandler } from '@sveltejs/kit';
import compare from 'compare-versions';
import got from 'got';

export const get: RequestHandler = async (request) => {
	try {
		const currentVersion = version;
		const versions = await got
			.get(
				`https://get.netka.io/versions.json?appId=${process.env['NTACLOUD_APP_ID']}&version=${currentVersion}`
			)
			.json();
		const latestVersion =
			request.url.hostname === 'staging.ntacloud.io'
				? versions['ntacloud'].next.version
				: versions['ntacloud'].main.version;
		const isUpdateAvailable = compare(latestVersion, currentVersion);
		return {
			body: {
				isUpdateAvailable: isUpdateAvailable === 1,
				latestVersion
			}
		};
	} catch (error) {
		console.log(error);
		return ErrorHandler(error);
	}
};

export const post: RequestHandler = async (event) => {
	const { type, latestVersion } = await event.request.json();
	if (type === 'update') {
		try {
			if (!dev) {
				await asyncExecShell(`docker pull netka/ntacloud:${latestVersion}`);
				await asyncExecShell(`env | grep NTACLOUD > .env`);
				await asyncExecShell(
					`docker run --rm -tid --env-file .env -v /var/run/docker.sock:/var/run/docker.sock -v ntacloud-db netka/ntacloud:${latestVersion} /bin/sh -c "env | grep NTACLOUD > .env && echo 'TAG=${latestVersion}' >> .env && docker stop -t 0 ntacloud ntacloud-redis && docker rm ntacloud ntacloud-redis && docker compose up -d --force-recreate"`
				);
				return {
					status: 200,
					body: {}
				};
			} else {
				console.log(latestVersion);
				await asyncSleep(2000);
				return {
					status: 200,
					body: {}
				};
			}
		} catch (error) {
			return ErrorHandler(error);
		}
	}
	return {
		status: 500
	};
};
