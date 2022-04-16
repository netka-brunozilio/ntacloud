import { getUserDetails } from '$lib/common';
import { ErrorHandler } from '$lib/database';
import { stopNTACloudProxy } from '$lib/haproxy';
import type { RequestHandler } from '@sveltejs/kit';

export const post: RequestHandler = async (event) => {
	const { teamId, status, body } = await getUserDetails(event);
	if (status === 401) return { status, body };

	const { engine } = await event.request.json();
	try {
		await stopNTACloudProxy(engine);
		return {
			status: 200
		};
	} catch (error) {
		return ErrorHandler(error);
	}
};
