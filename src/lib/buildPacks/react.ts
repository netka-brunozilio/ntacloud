import { buildCacheImageWithNode, buildImage } from '$lib/docker';
import { promises as fs } from 'fs';

const createDockerfile = async (data, image): Promise<void> => {
	const { applicationId, tag, workdir, publishDirectory } = data;
	const Dockerfile: Array<string> = [];

	Dockerfile.push(`FROM ${image}`);
	Dockerfile.push(`LABEL ntacloud.image=true`);
	Dockerfile.push('WORKDIR /app');
	Dockerfile.push(`COPY --from=${applicationId}:${tag}-cache /app/${publishDirectory} ./`);
	Dockerfile.push(`COPY /nginx.conf /etc/nginx/nginx.conf`);
	Dockerfile.push(`EXPOSE 80`);
	await fs.writeFile(`${workdir}/Dockerfile`, Dockerfile.join('\n'));
};

export default async function (data) {
	try {
		const image = 'webdevops/nginx:alpine';
		const imageForBuild = 'node:lts';
		await buildCacheImageWithNode(data, imageForBuild);
		await createDockerfile(data, image);
		await buildImage(data);
	} catch (error) {
		throw error;
	}
}
