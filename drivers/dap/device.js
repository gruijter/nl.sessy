/* eslint-disable no-await-in-loop */
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

const Homey = require('homey');
const util = require('util');
const charts = require('../../pricecharts');
const SessyCloud = require('../../sessy_cloud');

const setTimeoutPromise = util.promisify(setTimeout);

// calculate the average price of an array of prices
const average = (array) => array.reduce((partialAvg, value) => partialAvg + value / array.length, 0);

// map to array of only prices within chosen period
const selectPrices = ([...prices], start, end) => prices
	.filter((hourInfo) => new Date(hourInfo.time) >= start)
	.filter((hourInfo) => new Date(hourInfo.time) < end)
	.map((hourInfo) => hourInfo.muPrice);

class DapDevice extends Homey.Device {

	// INIT STUFF
	async onInit() {
		try {
			await this.destroyListeners();
			this.restarting = false;
			this.initReady = false;
			this.settings = await this.getSettings();
			this.timeZone = this.homey.clock.getTimezone();
			this.fetchDelay = (Math.random() * 1 * 60 * 1000); // spread over 1 minute
			if (!this.prices) this.prices = this.getStoreValue('prices');	// restore from persistent memory on app restart
			if (!this.prices) this.prices = [{ time: null, price: null, muPrice: null }];

			// setup pricing providers
			this.dap = [];
			this.dap[0] = new SessyCloud(this.settings);

			// fetch and handle prices now
			await this.setAvailable();
			await this.fetchPrices();
			// await this.setCapabilitiesAndFlows();

			// start fetching and handling prices on every hour
			this.eventListenerHour = async () => {
				this.log('new hour event received');
				await this.setCapabilitiesAndFlows();
				await setTimeoutPromise(this.fetchDelay, 'waiting is done'); // spread over 1 minute
				await this.fetchPrices();
			};
			this.homey.on('everyhour', this.eventListenerHour);

			this.initReady = true;
			this.log(`${this.getName()} finished initialization`);
		} catch (error) {
			this.error(error);
			// this.setUnavailable(error.message).catch(this.error);
			this.restartDevice(1 * 60 * 1000); // restart after 1 minute
		}
	}

	async onUninit() {
		this.log(`Homey is killing ${this.getName()}`);
		this.destroyListeners();
		this.homey.removeAllListeners('everyhour');
		const delay = 1500;
		await setTimeoutPromise(delay);
	}

	async destroyListeners() {
		if (this.eventListenerHour) await this.homey.removeListener('everyhour', this.eventListenerHour);
	}

	// STANDARD HOMEY STUFF
	async restartDevice(delay) {
		if (this.restarting) return;
		this.restarting = true;
		await this.destroyListeners();
		const dly = delay || 2000;
		this.log(`Device will restart in ${dly / 1000} seconds`);
		// this.setUnavailable('Device is restarting. Wait a few minutes!');
		await setTimeoutPromise(dly).then(() => this.onInit());
	}

	async onAdded() {
		this.log(`DAP added as device: ${this.getName()}`);
	}

	onDeleted() {
		this.destroyListeners();
		this.log(`DAP deleted as device: ${this.getName()}`);
	}

	onRenamed(name) {
		this.log(`DAP renamed to: ${name}`);
	}

	async onSettings({ newSettings }) { // changedKeys, oldSettings) {
		if (!this.initReady) throw Error('device is not ready. Ignoring new settings!');
		this.log(`${this.getName()} device settings changed by user`, newSettings);
		this.restartDevice(1000);
	}

	async setCapability(capability, value) {
		if (this.hasCapability(capability) && value !== undefined) {
			// only update changed capabilities
			if (value !== await this.getCapabilityValue(capability)) {
				this.setCapabilityValue(capability, value)
					.catch((error) => {
						this.error(error, capability, value);
					});
			}
		}
	}

	// GENERIC HELPERS
	async markUpPrices(marketPrices) {	// add markUp for price array, and convert price per mWh>kWh
		if (!marketPrices || !marketPrices[0]) return [];
		const muPrices = marketPrices.map((marketPrice) => {
			const muPrice = ((marketPrice.price * (1 + this.settings.variableMarkup / 100)) / 1000)
				+ this.settings.fixedMarkup;
			return {
				time: marketPrice.time,
				price: marketPrice.price,
				muPrice,
			};
		});
		return muPrices;
	}

	getUTCPeriods() {		// get UTC start of yesterday, today and tomorrow according to local Homey timezone
		const now = new Date();
		now.setMilliseconds(0); // toLocaleString cannot handle milliseconds...
		const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
		const homeyOffset = nowLocal - now;
		// this hour start in UTC
		const hourStart = new Date(nowLocal);
		hourStart.setMinutes(0);
		hourStart.setSeconds(0);
		hourStart.setMilliseconds(-homeyOffset); // convert back to UTC
		// this day start in UTC
		const todayStart = new Date(nowLocal);
		todayStart.setHours(0);
		todayStart.setMinutes(0);
		todayStart.setSeconds(0);
		todayStart.setMilliseconds(-homeyOffset); // convert back to UTC
		// yesterday start in UTC
		const yesterdayStart = new Date(todayStart);
		yesterdayStart.setDate(yesterdayStart.getDate() - 1);
		// tomorrow start in UTC
		const tomorrowStart = new Date(todayStart);
		tomorrowStart.setDate(tomorrowStart.getDate() + 1);
		// tomorrow end in UTC
		const tomorrowEnd = new Date(tomorrowStart);
		tomorrowEnd.setDate(tomorrowEnd.getDate() + 1); //  NEED TO CHECK THIS!!! IS ACTUALLY START OF NEXT DAY?
		// get the present hour (0 - 23)
		const H0 = nowLocal.getHours();
		return {
			now, nowLocal, homeyOffset, H0, hourStart, todayStart, yesterdayStart, tomorrowStart, tomorrowEnd,
		};
	}

	// EXECUTORS FOR CONDITION FLOWS AND TRIGGERS
	// async priceIsLowest(args) {
	// 	if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
	// 	let minimum = Math.min(...this.state.pricesThisDay);
	// 	if (args.period !== 'this_day') minimum = Math.min(...this.state.pricesNext8h.slice(0, Number(args.period)));
	// 	return this.state.priceNow <= minimum;
	// }

	// async priceIsLowestToday(args) {
	// 	if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
	// 	// sort and select number of lowest prices
	// 	const lowestNPrices = [...this.state.pricesThisDay].sort().slice(0, args.number);
	// 	return this.state.priceNow <= Math.max(...lowestNPrices);
	// }

	// async priceIsLowestBefore(args) {
	// 	if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
	// 	// calculate start and end hours compared to present hour
	// 	const thisHour = this.state.H0; // e.g. 23 hrs
	// 	let endHour = args.time; // e.g. 2 hrs
	// 	if (endHour < thisHour) endHour += 24; // e.g. 2 + 24 = 26 hrs ( = tomorrow!)
	// 	let startHour = endHour - args.period; // e.g. 26 - 4 = 22 hrs
	// 	// check if present hour is in scope op selected period
	// 	if ((thisHour >= endHour) || (thisHour < startHour)) return false;
	// 	// get period (2-8) hours pricing before end time
	// 	let pricesPartYesterday = [];
	// 	if (startHour < 0) {
	// 		pricesPartYesterday = this.state.pricesYesterday.slice(startHour);
	// 		startHour = 0;
	// 	}
	// 	let pricesPartTomorrow = [];
	// 	if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
	// 	const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour);
	// 	const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];
	// 	// sort and select number of lowest prices
	// 	const lowestNPrices = pricesTotalPeriod.sort().slice(0, args.number);
	// 	return this.state.priceNow <= Math.max(...lowestNPrices);
	// }

	// async priceIsLowestNextHours(args) {
	// 	if (!this.state || !this.state.pricesNextHours) throw Error('no prices available');
	// 	// select number of coming hours
	// 	const period = args.period ? args.period : 99;
	// 	const comingXhours = [...this.state.pricesNextHours].slice(0, period);
	// 	// sort and select number of lowest prices
	// 	const lowestNPrices = comingXhours.sort().slice(0, args.number);
	// 	return this.state.priceNow <= Math.max(...lowestNPrices);
	// }

	// async priceIsLowestAvg(args) {
	// 	if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
	// 	// args.period: '8' or 'this_day'  // args.hours: '2', '3', '4', '5' or '6'
	// 	let prices = [...this.state.pricesNext8h];
	// 	// calculate all avg prices for x hour periods for next 8 hours
	// 	const avgPricesNext8h = [];
	// 	prices.forEach((price, index) => {
	// 		if (index > prices.length - Number(args.hours)) return;
	// 		const hours = prices.slice(index, (index + Number(args.hours)));
	// 		const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
	// 		avgPricesNext8h.push(avgPrice);
	// 	});
	// 	let minAvgPrice = Math.min(...avgPricesNext8h);
	// 	// calculate all avg prices for x hour periods for this_day
	// 	if (args.period === 'this_day') {
	// 		prices = [...this.state.pricesThisDay];
	// 		const avgPricesThisDay = [];
	// 		prices.forEach((price, index) => {
	// 			if (index > prices.length - Number(args.hours)) return;
	// 			const hours = prices.slice(index, (index + Number(args.hours)));
	// 			const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
	// 			avgPricesThisDay.push(avgPrice);
	// 		});
	// 		minAvgPrice = Math.min(...avgPricesThisDay);
	// 	}
	// 	return avgPricesNext8h[0] <= minAvgPrice;
	// }

	// async priceIsHighest(args) {
	// 	if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
	// 	let maximum = Math.max(...this.state.pricesThisDay);
	// 	if (args.period !== 'this_day') maximum = Math.max(...this.state.pricesNext8h.slice(0, Number(args.period)));
	// 	return this.state.priceNow >= maximum;
	// }

	// async priceIsHighestToday(args) {
	// 	if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
	// 	// sort and select number of highest prices
	// 	const highestNPrices = [...this.state.pricesThisDay].sort().reverse().slice(0, args.number);
	// 	return this.state.priceNow >= Math.min(...highestNPrices);
	// }

	// async priceIsHighestNextHours(args) {
	// 	if (!this.state || !this.state.pricesNextHours) throw Error('no prices available');
	// 	// select number of coming hours
	// 	const comingXhours = [...this.state.pricesNextHours].slice(0, args.period);
	// 	// sort and select number of highest prices
	// 	const highestNPrices = comingXhours.sort().reverse().slice(0, args.number);
	// 	return this.state.priceNow >= Math.min(...highestNPrices);
	// }

	// async priceIsHighestBefore(args) {
	// 	if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
	// 	// calculate start and end hours compared to present hour
	// 	const thisHour = this.state.H0; // e.g. 23 hrs
	// 	let endHour = args.time; // e.g. 2 hrs
	// 	if (endHour < thisHour) endHour += 24; // e.g. 2 + 24 = 26 hrs ( = tomorrow!)
	// 	let startHour = endHour - args.period; // e.g. 26 - 4 = 22 hrs
	// 	// check if present hour is in scope op selected period
	// 	if ((thisHour >= endHour) || (thisHour < startHour)) return false;
	// 	// get period (2-8) hours pricing before end time
	// 	let pricesPartYesterday = [];
	// 	if (startHour < 0) {
	// 		pricesPartYesterday = this.state.pricesYesterday.slice(startHour);
	// 		startHour = 0;
	// 	}
	// 	let pricesPartTomorrow = [];
	// 	if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
	// 	const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour);
	// 	const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];
	// 	// sort and select number of lowest prices
	// 	const highestNPrices = pricesTotalPeriod.sort().reverse().slice(0, args.number);
	// 	return this.state.priceNow >= Math.min(...highestNPrices);
	// }

	// async priceIsHighestAvg(args) {
	// 	if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
	// 	// args.period: '8' or 'this_day'  // args.hours: '2', '3', '4', '5' or '6'
	// 	let prices = [...this.state.pricesNext8h];
	// 	// calculate all avg prices for x hour periods for next 8 hours
	// 	const avgPricesNext8h = [];
	// 	prices.forEach((price, index) => {
	// 		if (index > prices.length - Number(args.hours)) return;
	// 		const hours = prices.slice(index, (index + Number(args.hours)));
	// 		const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
	// 		avgPricesNext8h.push(avgPrice);
	// 	});
	// 	let maxAvgPrice = Math.max(...avgPricesNext8h);
	// 	// calculate all avg prices for x hour periods for this_day
	// 	if (args.period === 'this_day') {
	// 		prices = [...this.state.pricesThisDay];
	// 		const avgPricesThisDay = [];
	// 		prices.forEach((price, index) => {
	// 			if (index > prices.length - Number(args.hours)) return;
	// 			const hours = prices.slice(index, (index + Number(args.hours)));
	// 			const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
	// 			avgPricesThisDay.push(avgPrice);
	// 		});
	// 		maxAvgPrice = Math.max(...avgPricesThisDay);
	// 	}
	// 	return avgPricesNext8h[0] >= maxAvgPrice;
	// }

	// async priceIsBelowAvg(args) {
	// 	if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
	// 	const percent = 100 * (1 - this.state.priceNow / this.state[args.period]);
	// 	return percent >= Number(args.percent);
	// }

	// async priceIsAboveAvg(args) {
	// 	if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
	// 	const percent = 100 * (this.state.priceNow / this.state[args.period] - 1);
	// 	return percent >= Number(args.percent);
	// }

	async newPricesReceived(prices, period) {
		const roundedPrices = prices.map((price) => Math.round(price * 10000) / 10000);
		const priceString = JSON.stringify(({ ...roundedPrices }));
		const tokens = { prices: priceString };
		const state = { period };
		this.log(`${this.getName()} received new prices for ${period}`, roundedPrices);
		// this.homey.app.newPrices(this, tokens, state);
	}

	// MAIN FUNCTIONS
	// compare if new fetched market prices are same as old ones for given period, and trigger flow
	async checkNewMarketPrices(oldPrices, newPrices, period, periods) {
		// setup period this_day, tomorrow or next_hours
		let start = periods.todayStart;
		let end = periods.tomorrowStart;
		if (period === 'tomorrow') {
			start = periods.tomorrowStart;
			end = periods.tomorrowEnd;
		}
		if (period === 'next_hours') {
			start = periods.hourStart;
			end = 8640000000000000; // periods.tomorrowEnd;
		}
		const oldPricesSelection = oldPrices
			.filter((hourInfo) => new Date(hourInfo.time) >= start)
			.filter((hourInfo) => new Date(hourInfo.time) < end);
		const newPricesSelection = newPrices
			.filter((hourInfo) => new Date(hourInfo.time) >= start)
			.filter((hourInfo) => new Date(hourInfo.time) < end);

		// check for DST change or incomplete info
		if (period !== 'next_hours'
			&& newPricesSelection.length !== 24) this.log(`${this.getName()} received ${newPricesSelection.length} hours of prices for ${period}`);

		// check for same pricing content
		let samePrices = true;
		newPricesSelection.forEach((newHourPrice, index) => {
			if (oldPricesSelection[index] && oldPricesSelection[index].price !== undefined) {
				samePrices = samePrices && (newHourPrice.price === oldPricesSelection[index].price);
			} else samePrices = false;
		});

		// trigger flow
		if (!samePrices) {
			let prices = await this.markUpPrices([...newPricesSelection]); // add sales prices
			prices = selectPrices(prices, start, end); // map only sales prices
			await this.newPricesReceived(prices, period); // trigger flow
		}
	}

	// check validity of new fetched pricing data
	async checkPricesValidity(newMarketPrices, periods) {
		if ((!newMarketPrices || !newMarketPrices[0] || !newMarketPrices[0].time)) throw Error('Unable to fetch prices');
		// check if tomorrow is missing
		const marketPricesNextHours = newMarketPrices.filter((hourInfo) => hourInfo.time >= periods.hourStart);
		if (marketPricesNextHours.length < 10) throw Error('Unable to fetch tomorrow prices');
		// check if hours are consecutive
		let previousHour = new Date(newMarketPrices[0].time);
		let consecutive = true;
		newMarketPrices.forEach((price, idx) => {
			if (idx !== 0) {
				consecutive = consecutive && (new Date(price.time) - previousHour) === (1000 * 60 * 60);
				previousHour = new Date(price.time);
			}
		});
		if (!consecutive) {
			this.log(this.getName(), newMarketPrices);
			throw Error('Fetched prices are not in consecutive order');
		}
		// check if latest info is not older then before
		const oldPrices = [...this.prices];
		if (oldPrices && oldPrices[0] && oldPrices[0].time) {
			if (newMarketPrices.slice(-1).time < oldPrices.slice(-1).time) throw Error('Fetched prices are older then the stored prices');
		}
		return true;
	}

	async fetchPrices() {
		try {
			this.log(this.getName(), 'fetching prices of today and tomorrow (when available)');

			// fetch prices with retry and backup
			const periods = this.getUTCPeriods(); // now, nowLocal, homeyOffset, H0, hourStart, todayStart, yesterdayStart, tomorrowStart, tomorrowEnd
			if (!this.dap[0]) throw Error('no available DAP');
			let newMarketPrices;
			for (let index = 0; index < this.dap.length; index += 1) {
				newMarketPrices = await this.dap[index].getPrices({ dateStart: periods.yesterdayStart, dateEnd: periods.tomorrowEnd })
					.catch(this.log);
				const valid = await this.checkPricesValidity(newMarketPrices, periods).catch(this.log);
				if (!valid) {
					this.log(`${this.getName()} Error fetching prices from ${this.dap[index].host}. Trying again in 10 minutes`);
					await setTimeoutPromise(10 * 60 * 1000, 'waiting is done');
					newMarketPrices = await this.dap[index].getPrices({ dateStart: periods.yesterdayStart, dateEnd: periods.tomorrowEnd })
						.catch(this.log);
				} else {
					if (index !== 0) this.log('prices are not from primary service', this.dap[index].host);
					break;
				}
			}
			await this.checkPricesValidity(newMarketPrices, periods).catch(this.error);

			// store the new prices and update state, capabilities and price graphs
			const oldPrices = [...this.prices];
			await this.storePrices(newMarketPrices);
			await this.setCapabilitiesAndFlows({ noTriggers: true });

			// check if new prices received and trigger flows
			await this.checkNewMarketPrices(oldPrices, newMarketPrices, 'this_day', periods);
			await this.checkNewMarketPrices(oldPrices, newMarketPrices, 'tomorrow', periods);
			await this.checkNewMarketPrices(oldPrices, newMarketPrices, 'next_hours', periods);

		} catch (error) {
			this.error(error);
		}
	}

	// add markup and store new prices { time , price , muPrice  }
	async storePrices(newPrices) {
		try {
			const muPrices = await this.markUpPrices([...newPrices]);
			this.prices = [...muPrices];
			await this.setStoreValue('prices', [...muPrices]);
		} catch (error) {
			this.error(error);
		}
	}

	// calculate price state for different periods, and store it
	async setState() {
		if (!this.prices || !this.prices[0] || !this.prices[0].time) throw Error('no price info available');
		const periods = this.getUTCPeriods(); // now, nowLocal, homeyOffset, H0, hourStart, todayStart, yesterdayStart, tomorrowStart, tomorrowEnd

		// pricesYesterday
		const pricesYesterday = selectPrices(this.prices, periods.yesterdayStart, periods.todayStart);

		// pricesToday, avg, lowest and highest
		const pricesThisDay = selectPrices(this.prices, periods.todayStart, periods.tomorrowStart);
		const priceThisDayAvg = average(pricesThisDay);
		const priceThisDayLowest = Math.min(...pricesThisDay);
		const hourThisDayLowest = pricesThisDay.indexOf(priceThisDayLowest);
		const priceThisDayHighest = Math.max(...pricesThisDay);
		const hourThisDayHighest = pricesThisDay.indexOf(priceThisDayHighest);

		// priceNow, hourNow
		const { H0 } = periods; // the present hour (0 - 23)
		let [priceNow] = selectPrices(this.prices, periods.hourStart, periods.tomorrowStart);
		if (priceNow === undefined) priceNow = null;

		// pricesNext All Known Hours
		const pricesNextHours = this.prices
			.filter((hourInfo) => hourInfo.time >= periods.hourStart)
			.map((hourInfo) => hourInfo.muPrice);

		// pricesNext8h, avg, lowest and highest
		const pricesNext8h = pricesNextHours.slice(0, 8);
		const priceNext8hAvg = average(pricesNext8h);
		const priceNext8hLowest = Math.min(...pricesNext8h);
		const hourNext8hLowest = (H0 + pricesNext8h.indexOf(priceNext8hLowest)) % 24;
		const priceNext8hHighest = Math.max(...pricesNext8h);
		const hourNext8hHighest = (H0 + pricesNext8h.indexOf(priceNext8hHighest)) % 24;

		// pricesTomorrow, avg, lowest and highest
		const pricesTomorrow = selectPrices(this.prices, periods.tomorrowStart, periods.tomorrowEnd);
		let priceNextDayAvg = null;
		let priceNextDayLowest = null;
		let hourNextDayLowest = null;
		let priceNextDayHighest = null;
		let hourNextDayHighest = null;
		if (pricesTomorrow.length > 6) {
			priceNextDayAvg = average(pricesTomorrow);
			priceNextDayLowest = Math.min(...pricesTomorrow);
			hourNextDayLowest = pricesTomorrow.indexOf(priceNextDayLowest);
			priceNextDayHighest = Math.max(...pricesTomorrow);
			hourNextDayHighest = pricesTomorrow.indexOf(priceNextDayHighest);
		}

		const state = {
			pricesYesterday,

			pricesThisDay,
			priceThisDayAvg,
			this_day_avg: priceThisDayAvg,
			priceThisDayLowest,
			hourThisDayLowest,
			priceThisDayHighest,
			hourThisDayHighest,

			pricesNextHours,

			pricesNext8h,
			priceNext8hAvg,
			next_8h_avg: priceNext8hAvg,
			priceNext8hLowest,
			hourNext8hLowest,
			priceNext8hHighest,
			hourNext8hHighest,

			priceNow,
			H0,

			pricesTomorrow,
			priceNextDayAvg,
			priceNextDayLowest,
			hourNextDayLowest,
			priceNextDayHighest,
			hourNextDayHighest,
		};
		this.state = state;
	}

	async updatePriceCharts() {
		const urlToday = await charts.getChart(this.state.pricesThisDay);
		if (!this.todayPriceImage) {
			this.todayPriceImage = await this.homey.images.createImage();
			await this.todayPriceImage.setUrl(urlToday);
			await this.setCameraImage('todayPriceChart', ` ${this.homey.__('today')}`, this.todayPriceImage);
		} else {
			await this.todayPriceImage.setUrl(urlToday);
			await this.todayPriceImage.update();
		}

		const urlTomorow = await charts.getChart(this.state.pricesTomorrow);
		if (!this.tomorrowPriceImage) {
			this.tomorrowPriceImage = await this.homey.images.createImage();
			await this.tomorrowPriceImage.setUrl(urlTomorow);
			await this.setCameraImage('tomorrowPriceChart', ` ${this.homey.__('tomorrow')}`, this.tomorrowPriceImage);
		} else {
			await this.tomorrowPriceImage.setUrl(urlTomorow);
			await this.tomorrowPriceImage.update();
		}

		const urlNextHours = await charts.getChart(this.state.pricesNextHours);
		if (!this.nextHoursPriceImage) {
			this.nextHoursPriceImage = await this.homey.images.createImage();
			await this.nextHoursPriceImage.setUrl(urlNextHours);
			await this.setCameraImage('nextHoursPriceChart', ` ${this.homey.__('nextHours')}`, this.nextHoursPriceImage);
		} else {
			await this.nextHoursPriceImage.setUrl(urlNextHours);
			await this.nextHoursPriceImage.update();
		}
	}

	async setCapabilitiesAndFlows(options) {
		try {
			await this.setState();

			// set capabilities
			await this.setCapability('meter_price_this_day_lowest', this.state.priceThisDayLowest);
			await this.setCapability('hour_this_day_lowest', this.state.hourThisDayLowest);
			await this.setCapability('meter_price_next_8h_lowest', this.state.priceNext8hLowest);
			await this.setCapability('hour_next_8h_lowest', this.state.hourNext8hLowest);
			await this.setCapability('meter_price_this_day_highest', this.state.priceThisDayHighest);
			await this.setCapability('hour_this_day_highest', this.state.hourThisDayHighest);
			await this.setCapability('meter_price_next_8h_highest', this.state.priceNext8hHighest);
			await this.setCapability('hour_next_8h_highest', this.state.hourNext8hHighest);
			await this.setCapability('meter_price_this_day_avg', this.state.priceThisDayAvg);
			await this.setCapability('meter_price_next_8h_avg', this.state.priceNext8hAvg);
			await this.setCapability('meter_price_next_day_lowest', this.state.priceNextDayLowest);
			await this.setCapability('hour_next_day_lowest', this.state.hourNextDayLowest);
			await this.setCapability('meter_price_next_day_highest', this.state.priceNextDayHighest);
			await this.setCapability('hour_next_day_highest', this.state.hourNextDayHighest);
			await this.setCapability('meter_price_next_day_avg', this.state.priceNextDayAvg);
			const allSet = this.state.pricesNext8h.map((price, index) => this.setCapability(`meter_price_h${index}`, price).catch(this.error));
			await Promise.all(allSet);

			// update the price graphs
			await this.updatePriceCharts().catch(this.error);

			if (!options || !options.noTriggers) {
				// trigger new nextHours prices every hour
				if (this.state.pricesNextHours && this.state.pricesNextHours[0]) {
					this.newPricesReceived(this.state.pricesNextHours, 'next_hours').catch(this.error);
				}
				// trigger new prices received right after midnight
				if (this.state.H0 === 0) {
					if (this.state.pricesThisDay && this.state.pricesThisDay[0]) {
						this.newPricesReceived(this.state.pricesThisDay, 'this_day').catch(this.error);
					}
					if (this.state.pricesTomorrow && this.state.pricesTomorrow[0]) {
						this.newPricesReceived(this.state.pricesTomorrow, 'tomorrow').catch(this.error);
					}
				}

				// trigger flow cards
				if (Number.isFinite(this.state.priceNow)) {
					const tokens = { meter_price_h0: Number(this.state.priceNow.toFixed(this.settings.decimals)) };
					const state = { ...this.state };
					// this.homey.app.triggerPriceHighest(this, tokens, state);
					// this.homey.app.triggerPriceHighestBefore(this, tokens, state);
					// this.homey.app.triggerPriceHighestToday(this, tokens, state);
					// this.homey.app.triggerPriceAboveAvg(this, tokens, state);
					// this.homey.app.triggerPriceHighestAvg(this, tokens, state);
					// this.homey.app.triggerPriceLowest(this, tokens, state);
					// this.homey.app.triggerPriceLowestBefore(this, tokens, state);
					// this.homey.app.triggerPriceLowestToday(this, tokens, state);
					// this.homey.app.triggerPriceBelowAvg(this, tokens, state);
					// this.homey.app.triggerPriceLowestAvg(this, tokens, state);
				}
			}

		} catch (error) {
			this.error(error);
		}
	}

}

module.exports = DapDevice;
