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
const crypto = require('crypto');

const SessyCloud = require('../../sessy_cloud');

const capabilities = [
	'meter_price_h0',
	'meter_price_h1',
	'meter_price_h2',
	'meter_price_h3',
	'meter_price_h4',
	'meter_price_h5',
	'meter_price_h6',
	'meter_price_h7',
	'meter_price_this_day_avg',
	'meter_price_next_8h_avg',
	'meter_price_next_8h_lowest',
	'hour_next_8h_lowest',
	'meter_price_this_day_lowest',
	'hour_this_day_lowest',
	'meter_price_this_day_highest',
	'hour_this_day_highest',
	'meter_price_next_8h_highest',
	'hour_next_8h_highest',
	'meter_price_next_day_lowest',
	'hour_next_day_lowest',
	'meter_price_next_day_highest',
	'hour_next_day_highest',
	'meter_price_next_day_avg',
];

class DapDriver extends Driver {

	async onDriverInit() {
		this.log('onDriverInit');
	}

	async onUninit() {
		this.log('dap driver onUninit called');
		this.homey.removeAllListeners('everyhour');
	}

	async onPair(session) {

		let settings = {};
		if (this.homey.platform === 'cloud') this.log('Starting pair session on Homey cloud');
		else this.log('Starting pair session on Homey Pro');

		session.setHandler('portal_login', async (conSett) => {
			try {
				this.log(conSett);
				settings = conSett;
				const SESSY = new SessyCloud(settings);
				// check credentials and get price info
				await SESSY.login();
				return Promise.resolve(true);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

		session.setHandler('list_devices', async () => {
			try {
				this.log('pairing DAP started');
				const randomId = crypto.randomBytes(3).toString('hex');
				const devices = [
					{
						name: 'Dynamische Prijzen',
						data: {
							id: `dap_${randomId}`,
						},
						capabilities,
						settings: {
							username_portal: settings.username_portal,
							password_portal: settings.password_portal,
							variableMarkup: 21,
							fixedMarkup: 0.175,
						},
					},
				];
				return devices;
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

	}

}

module.exports = DapDriver;
