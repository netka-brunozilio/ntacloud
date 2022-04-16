import { asyncExecShell, getEngine, version } from '$lib/common';
import { prisma } from '$lib/database';
export default async function (): Promise<void> {
	const destinationDockers = await prisma.destinationDocker.findMany();
	const engines = [...new Set(destinationDockers.map(({ engine }) => engine))];
	for (const engine of engines) {
		const host = getEngine(engine);
		// Cleanup old ntacloud images
		try {
			let { stdout: images } = await asyncExecShell(
				`DOCKER_HOST=${host} docker images netka/ntacloud --filter before="netka/ntacloud:${version}" -q | xargs `
			);
			images = images.trim();
			if (images) {
				await asyncExecShell(`DOCKER_HOST=${host} docker rmi -f ${images}`);
			}
		} catch (error) {
			//console.log(error);
		}
		try {
			await asyncExecShell(`DOCKER_HOST=${host} docker container prune -f`);
		} catch (error) {
			//console.log(error);
		}
		try {
			await asyncExecShell(`DOCKER_HOST=${host} docker image prune -f --filter "until=2h"`);
		} catch (error) {
			//console.log(error);
		}
		// Cleanup old images older than a day
		try {
			await asyncExecShell(`DOCKER_HOST=${host} docker image prune --filter "until=72h" -a -f`);
		} catch (error) {
			//console.log(error);
		}
	}
}
