export type CreateDockerDestination = {
	name: string;
	engine: string;
	remoteEngine: boolean;
	network: string;
	isNTACloudProxyUsed: boolean;
	teamId: string;
};
