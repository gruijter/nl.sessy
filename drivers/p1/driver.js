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
const SessyCloud = require('../../sessy_cloud');

const capabilities = [
	'measure_power',
	'system_state',
];

class P1Driver extends Driver {

	async onInit() {
		this.ds = { capabilities };
		this.log('P1 driver has been initialized');
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

		session.setHandler('portal_login', async (conSett) => {
			try {
				this.log(conSett);
				const settings = conSett;
				const SESSY = new SessyCloud(settings);
				// check credentials and get all batteries
				const disc = await SESSY.discover({ p1: true });
				if (!disc || !disc[0]) throw Error((this.homey.__('pair.no_meters_registered')));
				discovered = [];
				disc.forEach(async (p1) => {
					const dev = { ...p1 };
					dev.id = p1.code;
					dev.name = p1.fullName;
					dev.usernamePortal = settings.username_portal;
					dev.passwordPortal = settings.password_portal;
					// dev.fwDongle = p1.version;
					dev.useLocalConnection = this.homey.platform !== 'cloud';
					discovered.push(dev);
				});
				return Promise.all(discovered);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

		session.setHandler('auto_login', async () => {
			try {
				const SESSY = new SessyLocal();
				const disc = await SESSY.discover({ p1: true }).catch(() => []);
				const discPromise = disc.map(async (p1) => {
					const dev = { ...p1 };
					// try to find MAC
					const mac = await this.homey.arp.getMAC(p1.ip).catch(() => '');
					let MAC = mac.replace(/:/g, '').toUpperCase();
					if (MAC === '') MAC = Math.random().toString(16).substring(2, 8);
					dev.name = `SESSY P1_${dev.ip}`;
					dev.id = MAC;
					dev.mac = mac;
					dev.useLocalConnection = true;
					return dev;
				});
				discovered = await Promise.all(discPromise);
				return Promise.all(discovered);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

		session.setHandler('list_devices', async () => {
			try {
				const allDevicesPromise = [];
				discovered.forEach(async (p1) => {
					// construct the homey device
					const device = {
						name: p1.name,
						data: {
							id: p1.id,
						},
						capabilities: ['measure_power', 'system_state'],
						settings: {
							id: p1.id,
							mac: p1.mac,
							username_portal: p1.usernamePortal,
							password_portal: p1.passwordPortal,
							use_local_connection: p1.useLocalConnection,
							// sn_dongle: p1.code,
							// password_dongle: p1.password_dongle,
							host: p1.ip,
							port: p1.port || 80,
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

module.exports = P1Driver;
