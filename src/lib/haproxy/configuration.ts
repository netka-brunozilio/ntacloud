import { dev } from '$app/env';
import got, { type Got } from 'got';
import * as db from '$lib/database';
import mustache from 'mustache';
import crypto from 'crypto';
import { checkContainer, checkHAProxy } from '.';
import { asyncExecShell, getDomain, getEngine } from '$lib/common';
import { supportedServiceTypesAndVersions } from '$lib/components/common';

const url = dev ? 'http://localhost:5555' : 'http://ntacloud-haproxy:5555';

const template = `program api 
  command /usr/bin/dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.hcl --userlist haproxy-dataplaneapi
  no option start-on-reload
	
global
  stats socket /var/run/api.sock user haproxy group haproxy mode 660 level admin expose-fd listeners
  log stdout format raw local0 debug
		 
defaults 
  mode http
  log global
  timeout http-request 120s
  timeout connect 10s
  timeout client 120s
  timeout server 120s

userlist haproxy-dataplaneapi 
  user admin insecure-password "\${HAPROXY_PASSWORD}"

frontend http
  mode http
  bind :80
  bind :443 ssl crt /usr/local/etc/haproxy/ssl/ alpn h2,http/1.1
  acl is_certbot path_beg /.well-known/acme-challenge/

  {{#applications}}
  {{#isHttps}}
  http-request redirect scheme https code ${
		dev ? 302 : 301
	} if { hdr(host) -i {{domain}} } !{ ssl_fc }
  {{/isHttps}}
  http-request redirect location {{{redirectValue}}} code ${
		dev ? 302 : 301
	} if { req.hdr(host) -i {{redirectTo}} }
  {{/applications}}

  {{#services}}
  {{#isHttps}}
  http-request redirect scheme https code ${
		dev ? 302 : 301
	} if { hdr(host) -i {{domain}} } !{ ssl_fc }
  {{/isHttps}}
  http-request redirect location {{{redirectValue}}} code ${
		dev ? 302 : 301
	} if { req.hdr(host) -i {{redirectTo}} }
  {{/services}}

  {{#ntacloud}}
  {{#isHttps}}
  http-request redirect scheme https code ${
		dev ? 302 : 301
	} if { hdr(host) -i {{domain}} } !{ ssl_fc }
  {{/isHttps}}
  http-request redirect location {{{redirectValue}}} code ${
		dev ? 302 : 301
	} if { req.hdr(host) -i {{redirectTo}} }
  {{/ntacloud}}

  use_backend backend-certbot if is_certbot
  use_backend %[req.hdr(host),lower]

frontend stats 
  bind *:8404
  stats enable
  stats uri /
  stats admin if TRUE
  stats auth "\${HAPROXY_USERNAME}:\${HAPROXY_PASSWORD}"

backend backend-certbot 
  mode http
  server certbot host.docker.internal:9080

{{#applications}}
{{#isRunning}}
# updatedAt={{updatedAt}}
backend {{domain}}
  option forwardfor
  {{#isHttps}}
  http-request add-header X-Forwarded-Proto https
  {{/isHttps}}
  {{^isHttps}}
  http-request add-header X-Forwarded-Proto http
  {{/isHttps}}
  http-request add-header X-Forwarded-Host %[req.hdr(host),lower]
  server {{id}} {{id}}:{{port}}
{{/isRunning}}
{{/applications}}

{{#services}}
{{#isRunning}}
# updatedAt={{updatedAt}}
backend {{domain}}
  option forwardfor
  {{#isHttps}}
  http-request add-header X-Forwarded-Proto https
  {{/isHttps}}
  {{^isHttps}}
  http-request add-header X-Forwarded-Proto http
  {{/isHttps}}
  http-request add-header X-Forwarded-Host %[req.hdr(host),lower]
  server {{id}} {{id}}:{{port}}
{{/isRunning}}
{{/services}}

{{#ntacloud}}
backend {{domain}}
  option forwardfor
  option httpchk GET /undead.json
  {{#isHttps}}
  http-request add-header X-Forwarded-Proto https
  {{/isHttps}}
  {{^isHttps}}
  http-request add-header X-Forwarded-Proto http
  {{/isHttps}}
  http-request add-header X-Forwarded-Host %[req.hdr(host),lower]
  server {{id}} {{id}}:{{port}} check fall 10
{{/ntacloud}}
`;

export async function haproxyInstance(): Promise<Got> {
	const { proxyPassword } = await db.listSettings();
	return got.extend({
		prefixUrl: url,
		username: 'admin',
		password: proxyPassword
	});
}

export async function configureHAProxy(): Promise<void> {
	const haproxy = await haproxyInstance();
	await checkHAProxy(haproxy);

	const data = {
		applications: [],
		services: [],
		ntacloud: []
	};
	const applications = await db.prisma.application.findMany({
		include: { destinationDocker: true, settings: true }
	});
	for (const application of applications) {
		const {
			fqdn,
			id,
			port,
			destinationDocker,
			destinationDockerId,
			settings: { previews },
			updatedAt
		} = application;
		if (destinationDockerId) {
			const { engine, network } = destinationDocker;
			const isRunning = await checkContainer(engine, id);
			if (fqdn) {
				const domain = getDomain(fqdn);
				const isHttps = fqdn.startsWith('https://');
				const isWWW = fqdn.includes('www.');
				const redirectValue = `${isHttps ? 'https://' : 'http://'}${domain}%[capture.req.uri]`;
				if (isRunning) {
					data.applications.push({
						id,
						port: port || 3000,
						domain,
						isRunning,
						isHttps,
						redirectValue,
						redirectTo: isWWW ? domain.replace('www.', '') : 'www.' + domain,
						updatedAt: updatedAt.getTime()
					});
				}
				if (previews) {
					const host = getEngine(engine);
					const { stdout } = await asyncExecShell(
						`DOCKER_HOST=${host} docker container ls --filter="status=running" --filter="network=${network}" --filter="name=${id}-" --format="{{json .Names}}"`
					);
					const containers = stdout
						.trim()
						.split('\n')
						.filter((a) => a)
						.map((c) => c.replace(/"/g, ''));
					if (containers.length > 0) {
						for (const container of containers) {
							const previewDomain = `${container.split('-')[1]}.${domain}`;
							data.applications.push({
								id: container,
								port: port || 3000,
								domain: previewDomain,
								isRunning,
								isHttps,
								redirectValue,
								redirectTo: isWWW ? previewDomain.replace('www.', '') : 'www.' + previewDomain,
								updatedAt: updatedAt.getTime()
							});
						}
					}
				}
			}
		}
	}
	const services = await db.prisma.service.findMany({
		include: {
			destinationDocker: true,
			minio: true,
			plausibleAnalytics: true,
			vscodeserver: true,
			wordpress: true,
			ghost: true,
			meiliSearch: true
		}
	});

	for (const service of services) {
		const { fqdn, id, type, destinationDocker, destinationDockerId, updatedAt } = service;
		if (destinationDockerId) {
			const { engine } = destinationDocker;
			const found = supportedServiceTypesAndVersions.find((a) => a.name === type);
			if (found) {
				const port = found.ports.main;
				const publicPort = service[type]?.publicPort;
				const isRunning = await checkContainer(engine, id);
				if (fqdn) {
					const domain = getDomain(fqdn);
					const isHttps = fqdn.startsWith('https://');
					const isWWW = fqdn.includes('www.');
					const redirectValue = `${isHttps ? 'https://' : 'http://'}${domain}%[capture.req.uri]`;
					if (isRunning) {
						data.services.push({
							id,
							port,
							publicPort,
							domain,
							isRunning,
							isHttps,
							redirectValue,
							redirectTo: isWWW ? domain.replace('www.', '') : 'www.' + domain,
							updatedAt: updatedAt.getTime()
						});
					}
				}
			}
		}
	}
	const { fqdn } = await db.prisma.setting.findFirst();
	if (fqdn) {
		const domain = getDomain(fqdn);
		const isHttps = fqdn.startsWith('https://');
		const isWWW = fqdn.includes('www.');
		const redirectValue = `${isHttps ? 'https://' : 'http://'}${domain}%[capture.req.uri]`;
		data.ntacloud.push({
			id: dev ? 'host.docker.internal' : 'ntacloud',
			port: 3000,
			domain,
			isHttps,
			redirectValue,
			redirectTo: isWWW ? domain.replace('www.', '') : 'www.' + domain
		});
	}
	const output = mustache.render(template, data);
	const newHash = crypto.createHash('md5').update(output).digest('hex');
	const { proxyHash, id } = await db.listSettings();
	if (proxyHash !== newHash) {
		await db.prisma.setting.update({ where: { id }, data: { proxyHash: newHash } });
		await haproxy.post(`v2/services/haproxy/configuration/raw`, {
			searchParams: {
				skip_version: true
			},
			body: output,
			headers: {
				'Content-Type': 'text/plain'
			}
		});
	}
}
