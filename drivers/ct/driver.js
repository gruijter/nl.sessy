/*
Copyright 2023, Robin de Gruijter (gruijter@hotmail.com)

This file is part of nl.sessy.

nl.sessy is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

nl.sessy is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with nl.sessy. If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const { Driver } = require('homey');
const SessyLocal = require('../../sessy_local');
// const SessyCloud = require('../../sessy_cloud');

const capabilities = [
	'measure_power',

	'measure_power.l1',
	'measure_power.l2',
	'measure_power.l3',
	'measure_current.l1',
	'measure_current.l2',
	'measure_current.l3',

	'measure_voltage.l1',
	'measure_voltage.l2',
	'measure_voltage.l3',

	'system_state',
];

class CTDriver extends Driver {

	async onInit() {
		this.ds = { capabilities };
		this.log('CT driver has been initialized');
	}

	async onPair(session) {

		if (this.homey.platform === 'cloud') this.log('Starting pair session on Homey cloud');
		else this.log('Starting pair session on Homey Pro');
		let discovered = [];

		session.setHandler('showView', async (viewId) => {
			// switch to Pro pairing view
			if (viewId === 'portal_login' && this.homey.platform !== 'cloud') await session.showView('portal_login_pro');
			if (viewId === 'done' && this.homey.platform !== 'cloud') this.log('done pairing');
		});

		// session.setHandler('portal_login', async (conSett) => {
		// 	try {
		// 		this.log(conSett);
		// 		const settings = conSett;
		// 		const SESSY = new SessyCloud(settings);
		// 		// check credentials and get all batteries
		// 		const disc = await SESSY.discover({ ct: true });
		// 		if (!disc || !disc[0]) throw Error((this.homey.__('pair.no_meters_registered')));
		// 		discovered = [];
		// 		disc.forEach(async (ct) => {
		// 			const dev = { ...ct };
		// 			dev.id = ct.code;
		// 			dev.name = ct.fullName;
		// 			dev.usernamePortal = settings.username_portal;
		// 			dev.passwordPortal = settings.password_portal;
		// 			// dev.fwDongle = ct.version;
		// 			dev.useLocalConnection = this.homey.platform !== 'cloud';
		// 			discovered.push(dev);
		// 		});
		// 		return Promise.all(discovered);
		// 	} catch (error) {
		// 		this.error(error);
		// 		return Promise.reject(error);
		// 	}
		// });

		const discover = async () => {
			const discoveryStrategy = this.getDiscoveryStrategy();
			const discoveryResults = await discoveryStrategy.getDiscoveryResults();
			const disc = Object.values(discoveryResults)
				.filter((discoveryResult) => discoveryResult.txt.device.includes('CT'))
				.map((discoveryResult) => ({
					name: `SESSY_CT_${discoveryResult.txt.serial}`,
					id: discoveryResult.txt.serial,
					ip: discoveryResult.address,
					port: discoveryResult.port,
					useMdns: true,
					useLocalConnection: true,
					sn_dongle: discoveryResult.txt.serial,
				}));
			const discPromise = disc.map(async (sessy) => {
				const dev = { ...sessy };
				// add status info
				const SESSY = new SessyLocal({ host: dev.ip, port: dev.port });
				dev.status = await SESSY.getStatus({ ct: true }).catch(this.error);
				return dev;
			});
			discovered = await Promise.all(discPromise);
			return Promise.all(discovered);
		};

		session.setHandler('discover', async () => {
			try {
				let disc = await discover();
				if (!disc || !disc[0]) disc = [{}];
				return Promise.resolve(disc[0]);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

		session.setHandler('manual_login', async (conSett) => {
			try {
				this.log(conSett);
				const dev = { ...conSett };
				// check credentials and get status info
				const SESSY = new SessyLocal({ host: dev.host, port: dev.port });
				dev.status = await SESSY.getStatus({ ct: true });
				dev.name = `CT_${dev.sn_dongle}`;
				dev.id = dev.sn_dongle;
				dev.ip = dev.host;
				dev.useMdns = dev.use_mdns;
				dev.useLocalConnection = true;
				// dev.sn_dongle = dev.sn_dongle;
				// dev.password_dongle = settings.password_dongle;
				discovered = [dev];
				return Promise.all(discovered);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

		session.setHandler('list_devices', async () => {
			try {
				const allDevicesPromise = [];
				discovered.forEach(async (ct) => {
					// construct the homey device
					const device = {
						name: ct.name,
						data: {
							id: ct.id,
						},
						capabilities,
						settings: {
							id: ct.id,
							username_portal: ct.usernamePortal,
							password_portal: ct.passwordPortal,
							// use_local_connection: ct.useLocalConnection,
							sn_dongle: ct.id,
							password_dongle: ct.password_dongle,
							host: ct.ip,
							port: ct.port || 80,
							use_mdns: ct.useMdns,
						},
					};
					allDevicesPromise.push(device);
				});
				const devices = await Promise.all(allDevicesPromise);
				// console.dir(devices, { depth: null });
				return Promise.resolve(devices);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

	}

}

module.exports = CTDriver;
