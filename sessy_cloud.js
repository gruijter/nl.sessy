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

const https = require('https');
// const util = require('util');

// const setTimeoutPromise = util.promisify(setTimeout);

// AUTH
const loginEP = '/Authentication/Login';
const getInstallationsEP = '/User/GetInstallations';

// SESSY
const getSessyBatteryListEP = '/SessyBattery/List';
const getStatusEP = '/DongleTelemetrics/Single';
const getFirmwareUpdateNoteEP = '/Notification/LatestFirmwareUpdateNote';

// P1
const getP1ListEP = '/SessyBattery/GetUserMeter';
const getP1StatusEP = '/MeterTelemetrics/Single';

// Price
// const getEnergyPriceEP = '/EnergyPrice/GraphData'; // ?Period=4
const getEnergyPriceByDateEP = '/EnergyPrice/GraphDataByDate';

const defaultHost = 'api.sessy.nl'; // 'charged-api-test.azurewebsites.net'; // 'api.sessy.nl';
const defaultPort = 443;
const defaultTimeout = 15000;

const systemStates = {
	1: 'SYSTEM_STATE_INIT',
	2: 'SYSTEM_STATE_STANDBY', // 'SYSTEM_STATE_WAIT_FOR_PERIPHERALS',
	3: 'SYSTEM_STATE_STANDBY',
	4: 'SYSTEM_STATE_WAITING_FOR_SAFE_SITUATION',
	5: 'SYSTEM_STATE_WAITING_IN_SAFE_SITUATION',
	6: 'SYSTEM_STATE_RUNNING_SAFE',
	7: 'SYSTEM_STATE_OVERRIDE_OVERFREQUENCY',
	8: 'SYSTEM_STATE_OVERRIDE_UNDERFREQUENCY',
	9: 'SYSTEM_STATE_DISCONNECT',
	10: 'SYSTEM_STATE_RECONNECT',
	11: 'SYSTEM_STATE_ERROR',
	12: 'SYSTEM_STATE_BATTERY_EMPTY_OR_FULL',
	13: 'SYSTEM_STATE_BATTERY_FULL',
	14: 'SYSTEM_STATE_BATTERY_EMPTY',
};

// Represents a session to the Sessy Cloud API.
class Sessy {
	constructor(opts) {
		const options = opts || {};
		this.username = options.username_portal;
		this.password = options.password_portal;
		this.deviceId = options.id;
		this.host = defaultHost;
		this.port = defaultPort;
		this.timeout = options.timeout || defaultTimeout;
		this.token = '';
		this.validTo = null;
		this.lastResponse = undefined;
	}

	async login(opts) {
		try {
			const options = opts || {};
			const username = options.username_portal || this.username;
			const password = options.password_portal || this.password;
			const timeout = options.timeout || this.timeout;
			this.username = username;
			this.password = password;
			this.timeout = timeout;
			const data = {
				username,
				password: Buffer.from(password).toString('base64'),
			};
			const res = await this._makeRequest(loginEP, data);
			const { token, validTo } = res;
			if (!token) throw Error('No token received');
			this.token = token;
			this.validTo = validTo;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getInstallations() {
		try {
			const data = '';
			const res = await this._makeRequest(getInstallationsEP, data);
			this.installations = res;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getP1List(opts) {
		try {
			const options = opts || {};
			const installationId = options.installationId || this.installationId;
			const userId = options.userId || this.userId;
			const data = '';
			const EP = `${getP1ListEP}?UserId=${userId}&InstallationId=${installationId}`;
			const res = await this._makeRequest(EP, data);
			this.p1List = res;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getSessyBatteryList(opts) {
		try {
			const options = opts || {};
			const installationId = options.installationId || this.installationId;
			const data = '';
			const EP = `${getSessyBatteryListEP}?InstallationId=${installationId}`;
			const res = await this._makeRequest(EP, data);
			this.batteryList = res;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getStatus(opts) {
		try {
			const options = opts || {};
			const deviceId = options.deviceId || this.deviceId;
			const data = '';
			const statusEP = options.p1 ? getP1StatusEP : getStatusEP;
			const EP = `${statusEP}?DeviceId=${deviceId}&IsDescending=true`;
			const res = await this._makeRequest(EP, data);
			// make compatible with local api:
			res.status = 'ok';
			if (options.p1) {
				res.state =	'P1_OK';
				res.net_power_delivered = res.data.totalPowerConsumed / 1000;
			} else {
				res.sessy = {
					state_of_charge: res.data.battery.stateOfCharge,
					power: -res.data.inverter.acPower,
					power_setpoint: -res.data.powerSetpoint,
					system_state: systemStates[res.data.sessyState],
					frequency: res.data.inverter.acFrequency,
				};
				res.renewable_energy_phase1 = {
					voltage_rms: res.data.phase1.acVoltage,
					current_rms: null,
					power: res.data.phase1.acPower,
				};
				res.renewable_energy_phase2 = {
					voltage_rms: res.data.phase2.acVoltage,
					current_rms: null,
					power: res.data.phase2.acPower,
				};
				res.renewable_energy_phase3 = {
					voltage_rms: res.data.phase3.acVoltage,
					current_rms: null,
					power: res.data.phase3.acPower,
				};
			}
			this.lastStatus = res;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getOTAStatus(opts) {
		try {
			const options = opts || {};
			const deviceId = options.deviceId || this.deviceId;
			const data = '';
			const batts = await this.discover();
			const bat = batts.find((b) => b.code === deviceId);
			const EP = getFirmwareUpdateNoteEP;
			const res = await this._makeRequest(EP, data);
			// make compatible with local api:
			res.status = 'ok';
			res.self =	{
				installed_firmware:	{	version:	bat.acBoardVersion },
				available_firmware:	{ version:	bat.acBoardVersion }, // NEED TO EXTRACT NEW FW
			};
			res.serial =	{
				installed_firmware:	{	version:	bat.version },
				available_firmware:	{ version:	bat.version }, // NEED TO EXTRACT NEW FW
			};
			this.OTAstatus = res;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getEnergyPrice() {
		try {
			const today = new Date();
			today.setUTCHours(0, 0, 0, 0);
			const tomorrow = new Date(today);
			tomorrow.setDate(tomorrow.getDate() + 1);
			const yesterday = new Date(today);
			yesterday.setDate(yesterday.getDate() - 1);
			const data = '';
			const EPYesterday = `${getEnergyPriceByDateEP}?Date=${yesterday.valueOf()}`;
			const EPToday = `${getEnergyPriceByDateEP}?Date=${today.valueOf()}`;
			const EPTomorrow = `${getEnergyPriceByDateEP}?Date=${tomorrow.valueOf()}`;
			const resYesterday = await this._makeRequest(EPYesterday, data).catch(() => []);
			const resToday = await this._makeRequest(EPToday, data).catch(() => []);
			const resTomorrow = await this._makeRequest(EPTomorrow, data).catch(() => []);
			const res = resYesterday
				.concat(resToday, resTomorrow)
				.filter((value, index, self) =>	index === self.findIndex((t) => (t.dateTime === value.dateTime))); // remove doubles
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getPrices(options) {
		try {
			const today = new Date();
			today.setHours(0);
			const tomorrow = new Date(today);
			tomorrow.setDate(today.getDate() + 1);

			const opts = options || {};
			const start = opts.dateStart ? new Date(opts.dateStart) : today;
			const end = opts.dateEnd ? new Date(opts.dateEnd) : tomorrow;
			const res = await this.getEnergyPrice();

			// make array with concise info per day in euro
			const info = res
				.map((hourInfo) => ({ time: new Date(hourInfo.dateTime), price: hourInfo.price * 1000 }))
				.filter((hourInfo) => new Date(hourInfo.time) >= start) // remove out of bounds data
				.filter((hourInfo) => new Date(hourInfo.time) <= end);

			return Promise.resolve(info);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async discover(opts) {
		try {
			const installations = await this.getInstallations();
			if (!installations || !installations[0] || !installations[0].id) throw Error('No installtions found');
			let discovered = [];
			const discoveredUnits = [];
			const p1 = opts && opts.p1;
			const prom = await installations.map(async (inst) => {
				if (p1) {
					const p1List = await this.getP1List({ installationId: inst.id, userId: inst.userInstallations[0].userId });
					discoveredUnits.push(p1List);
				} else {
					const batList = await this.getSessyBatteryList({ installationId: inst.id });
					batList.forEach((bat) => discoveredUnits.push(bat));
				}
			});
			await Promise.all(prom);
			discovered = discoveredUnits.map(async (item) => {
				const unit = item;
				unit.ip = item.ethernetIpAddress !== '0.0.0.0' ? item.ethernetIpAddress : item.wifiIpAddress;
				unit.status = await this.getStatus({ deviceId: item.code, p1 });
				return unit;
			});
			return Promise.all(discovered);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async _makeRequest(actionPath, data, timeout, host) {
		try {
			// check token validity
			if (actionPath !== loginEP) {
				if ((this.validTo - Date.now()) < 60 * 60 * 1000) await this.login();
			}
			const postData = JSON.stringify(data);
			const headers = {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.token}`,
			};
			const options = {
				hostname: host || this.host,
				port: this.port,
				path: actionPath,
				headers,
				method: 'GET',
			};
			if (data && data !== '') options.method = 'POST';
			// console.log(options, postData);
			const result = await this._makeHttpsRequest(options, postData, timeout);
			this.lastResponse = result.body || result.statusCode;
			const contentType = result.headers['content-type'];
			// find errors
			if (result.statusCode === 500) {
				throw Error(`Request Failed: ${result.statusMessage} ${result.body}`);
			}
			if (result.statusCode === 401) {
				throw Error('Athentication failure', result.statusMessage);
			}
			if (result.statusCode !== 200) {
				this.lastResponse = result.statusCode;
				throw Error(`HTTP request Failed. Status Code: ${result.statusCode} ${result.statusMessage}`);
			}
			if (!/application\/json/.test(contentType)) {
				throw Error(`Expected json but received ${contentType}: ${result.body}`);
			}
			const json = JSON.parse(result.body);
			// console.dir(json, { depth: null });
			return Promise.resolve(json);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	_makeHttpsRequest(options, postData, timeout) {
		return new Promise((resolve, reject) => {
			const opts = options;
			opts.timeout = timeout || this.timeout;
			const req = https.request(opts, (res) => {
				let resBody = '';
				res.on('data', (chunk) => {
					resBody += chunk;
				});
				res.once('end', () => {
					this.lastResponse = resBody;
					if (!res.complete) {
						return reject(Error('The connection was terminated while the message was still being sent'));
					}
					res.body = resBody;
					return resolve(res);
				});
			});
			req.on('error', (e) => {
				req.destroy();
				this.lastResponse = e;
				return reject(e);
			});
			req.on('timeout', () => {
				req.destroy();
			});
			req.end(postData);
		});
	}

}

module.exports = Sessy;

/*
[
  {
    dateTime: 1692576000000,
    price: 0.09871,
    adjustedPrice: 0.09871,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0207291
  },
  {
    dateTime: 1692579600000,
    price: 0.09512,
    adjustedPrice: 0.09512,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0199752
  },
  {
    dateTime: 1692583200000,
    price: 0.09771,
    adjustedPrice: 0.09771,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0205191
  },
  {
    dateTime: 1692586800000,
    price: 0.10647,
    adjustedPrice: 0.10647,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0223587
  },
  {
    dateTime: 1692590400000,
    price: 0.13884,
    adjustedPrice: 0.13884,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0291564
  },
  {
    dateTime: 1692594000000,
    price: 0.16093,
    adjustedPrice: 0.16093,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0337953
  },
  {
    dateTime: 1692597600000,
    price: 0.13727,
    adjustedPrice: 0.13727,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0288267
  },
  {
    dateTime: 1692601200000,
    price: 0.11507,
    adjustedPrice: 0.11507,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0241647
  },
  {
    dateTime: 1692604800000,
    price: 0.10402,
    adjustedPrice: 0.10402,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0218442
  },
  {
    dateTime: 1692608400000,
    price: 0.08852,
    adjustedPrice: 0.08852,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0185892
  },
  {
    dateTime: 1692612000000,
    price: 0.0754,
    adjustedPrice: 0.0754,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.015834
  },
  {
    dateTime: 1692615600000,
    price: 0.0649,
    adjustedPrice: 0.0649,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.013629
  },
  {
    dateTime: 1692619200000,
    price: 0.07772,
    adjustedPrice: 0.07772,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0163212
  },
  {
    dateTime: 1692622800000,
    price: 0.0873,
    adjustedPrice: 0.0873,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.018333
  },
  {
    dateTime: 1692626400000,
    price: 0.09617,
    adjustedPrice: 0.09617,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0201957
  },
  {
    dateTime: 1692630000000,
    price: 0.11868,
    adjustedPrice: 0.11868,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0249228
  },
  {
    dateTime: 1692633600000,
    price: 0.14277,
    adjustedPrice: 0.14277,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0299817
  },
  {
    dateTime: 1692637200000,
    price: 0.18673,
    adjustedPrice: 0.18673,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0392133
  },
  {
    dateTime: 1692640800000,
    price: 0.20345,
    adjustedPrice: 0.20345,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0427245
  },
  {
    dateTime: 1692644400000,
    price: 0.16635,
    adjustedPrice: 0.16635,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0349335
  },
  {
    dateTime: 1692648000000,
    price: 0.13601,
    adjustedPrice: 0.13601,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.0285621
  },
  {
    dateTime: 1692651600000,
    price: 0.115,
    adjustedPrice: 0.115,
    storage: 0,
    energyTax: 0,
    optional: 0,
    vat: 0.02415
  }
]
*/
