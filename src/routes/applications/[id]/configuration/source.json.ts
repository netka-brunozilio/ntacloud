import { getUserDetails } from '$lib/common';
import * as db from '$lib/database';
import { ErrorHandler } from '$lib/database';
import type { RequestHandler } from '@sveltejs/kit';

export const post: RequestHandler = async (event) => {
	const { teamId, status, body } = await getUserDetails(event);
	if (status === 401) return { status, body };

	const { id } = event.params;
	const { gitSourceId } = await event.request.json();
	try {
		await db.configureGitsource({ id, gitSourceId });
		return { status: 201 };
	} catch (error) {
		return ErrorHandler(error);
	}
};
