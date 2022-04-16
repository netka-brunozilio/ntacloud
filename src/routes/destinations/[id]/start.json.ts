import { getUserDetails } from '$lib/common';
import { ErrorHandler } from '$lib/database';
import { startNTACloudProxy, stopNTACloudProxy } from '$lib/haproxy';
import type { RequestHandler } from '@sveltejs/kit';

export const post: RequestHandler = async (event) => {
	const { teamId, status, body } = await getUserDetails(event);
	if (status === 401) return { status, body };

	const { engine } = await event.request.json();

	try {
		await startNTACloudProxy(engine);
		return {
			status: 200
		};
	} catch (error) {
		await stopNTACloudProxy(engine);
		return ErrorHandler(error);
	}
};
