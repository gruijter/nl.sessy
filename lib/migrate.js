/* eslint-disable no-await-in-loop */

/*
Copyright 2023 - 2026, Robin de Gruijter (gruijter@hotmail.com)

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

const { setTimeoutPromise } = require('./util');

async function migrateCapabilities(device, correctCaps) {
  device.log(`checking device migration for ${device.getName()}`);

  // store the capability states before migration, via the public API (not the undocumented
  // internal `Symbol(state)`, which is not guaranteed to exist on every SDK/firmware version)
  const existingCaps = await device.getCapabilities();
  const state = {};
  existingCaps.forEach((cap) => { state[cap] = device.getCapabilityValue(cap); });

  // snapshot the capability list once and diff against it, instead of re-fetching
  // device.getCapabilities() on every loop iteration (extra round-trips per capability)
  const caps = existingCaps;
  const maxLen = Math.max(caps.length, correctCaps.length);
  let firstMismatch = -1;
  for (let index = 0; index < maxLen; index += 1) {
    if (caps[index] !== correctCaps[index]) {
      firstMismatch = index;
      break;
    }
  }
  if (firstMismatch === -1) return;

  device.setUnavailable(device.homey.__('sessy.migrating')).catch(() => null);

  // remove all caps from the first mismatch onward (also covers extra trailing caps not in
  // correctCaps at all)
  for (let i = firstMismatch; i < caps.length; i += 1) {
    if (device.isUninitialized) return;
    if (device.hasCapability(caps[i])) {
      device.log(`removing capability ${caps[i]} for ${device.getName()}`);
      await device.removeCapability(caps[i]).catch((error) => device.log(error));
      await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
    }
  }

  // add the missing caps and restore their state
  for (let index = firstMismatch; index < correctCaps.length; index += 1) {
    if (device.isUninitialized) return;
    const newCap = correctCaps[index];
    if (!device.hasCapability(newCap)) {
      device.log(`adding capability ${newCap} for ${device.getName()}`);
      await device.addCapability(newCap).catch((error) => device.error(error));
    }
    if (state[newCap] !== undefined) {
      device.log(`${device.getName()} restoring value ${newCap} to ${state[newCap]}`);
      await device.setCapability(newCap, state[newCap]).catch((e) => device.error(e));
    }
    await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
  }
}

module.exports = { migrateCapabilities };
