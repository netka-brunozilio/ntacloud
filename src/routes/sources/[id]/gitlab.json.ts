import { getUserDetails } from '$lib/common';
import * as db from '$lib/database';
import { ErrorHandler } from '$lib/database';
import type { RequestHandler } from '@sveltejs/kit';

export const post: RequestHandler = async (event) => {
	const { teamId, status, body } = await getUserDetails(event);
	if (status === 401) return { status, body };
	const { id } = event.params;

	try {
		let { type, name, htmlUrl, apiUrl, oauthId, appId, appSecret, groupName } =
			await event.request.json();

		oauthId = Number(oauthId);

		await db.addGitLabSource({
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
		});
		return { status: 201 };
	} catch (error) {
		return ErrorHandler(error);
	}
};
