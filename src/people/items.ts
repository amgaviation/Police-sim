import { unitHash } from '../records/hash';
import type { PersonRecord } from '../records/person';
import { ITEMS, PEOPLE_DATA } from './data';
import { SALT } from './salt';
import type { CarriedItem, DrugKind, ItemDef } from './types';

/** Item table lookups and the pure item generators (design §5.3). */

export { ITEMS } from './data';

const BY_ID: ReadonlyMap<string, ItemDef> = new Map(ITEMS.map((i) => [i.id, i]));

/** Definition of item `id`; throws on an unknown id. */
export function itemDef(id: string): ItemDef {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`Unknown item "${id}"`);
  return d;
}

export function isItemId(id: string): boolean {
  return BY_ID.has(id);
}

/** Officer-safety note text that marks a person as likely armed. */
const CARRY_NOTE = 'carry weapons';

/** True when the record has the "carry weapons" officer-safety note. */
export function hasCarryNote(record: PersonRecord): boolean {
  return record.officerSafety.some((n) => n.toLowerCase().includes(CARRY_NOTE));
}

/** True when the record lists a registered handgun or revolver. */
export function hasRegisteredHandgun(record: PersonRecord): boolean {
  return record.firearms.some((f) => /^(handgun|revolver)/i.test(f.type));
}

/** Probability `rate` scaled up by risk (0 stays 0): the "IfRisk" rates. */
function riskRate(rate: number, risk: number): number {
  return risk <= 0 ? 0 : Math.min(1, rate * (1 + 4 * risk));
}

/** The drug item a user of `kind` carries, or null. */
function drugItem(kind: DrugKind): string | null {
  switch (kind) {
    case 'cannabis':
      return 'cannabis';
    case 'stimulant':
      return 'narcotics';
    case 'opioid':
    case 'depressant':
      return 'pills';
    default:
      return null;
  }
}

function paraphernaliaItem(kind: DrugKind): string | null {
  if (kind === 'cannabis' || kind === 'stimulant') return 'pipe';
  return kind === 'opioid' ? 'syringe' : null;
}

/** What `baseItems` needs of the identity traits (computed before the items). */
export interface ItemTraits {
  readonly risk: number;
  readonly drugUse: DrugKind;
}

/**
 * Items carried by person `id` on `epochDay`: daily personal items (`items.daily`, salt ^ epochDay), the
 * licence, and persistent contraband (fake ID, weapons) from the record and risk. Instance ids `p<id>:<item>:0`.
 */
export function baseItems(seed: number, id: number, record: PersonRecord, traits: ItemTraits, epochDay: number): CarriedItem[] {
  const it = PEOPLE_DATA.items;
  const out: CarriedItem[] = [];
  const add = (item: string, where: CarriedItem['where'], visible = false): void => {
    out.push({ instance: `p${id}:${item}:0`, item, where, visible });
  };
  const daily = (salt: number): number => unitHash(seed, salt ^ epochDay, id);
  const backpack = daily(SALT.itemBackpack) < it.daily.backpack;
  const stash: CarriedItem['where'] = backpack ? 'bag' : 'pocket';

  if (daily(SALT.itemPhone) < it.daily.phone) add('phone', 'pocket');
  if (daily(SALT.itemWallet) < it.daily.wallet) add('wallet', 'pocket');
  if (daily(SALT.itemKeys) < it.daily.keys) add('keys', 'pocket');
  if (daily(SALT.itemCash) < it.daily.cashRoll) add('cashRoll', 'pocket');
  if (backpack) add('backpack', 'hand', true);
  if (record.license.status !== 'none' && daily(SALT.itemLicense) < it.driversLicenseCarry) add('driversLicense', 'pocket');
  if (traits.risk > 0.4 && unitHash(seed, SALT.itemFakeId, id) < it.fakeIdIfRisk) add('fakeId', 'pocket');

  // Persistent weapons.
  const safetyNote = record.officerSafety.length > 0;
  if (unitHash(seed, SALT.itemKnife, id) < (safetyNote ? it.knifeIfSafetyNote : it.knife)) add('knife', 'waistband');
  let pGun = hasCarryNote(record) ? it.handgunIfSafetyNote : 0;
  if (hasRegisteredHandgun(record)) pGun = Math.max(pGun, it.handgunIfRegistered);
  if (pGun > 0 && unitHash(seed, SALT.itemHandgun, id) < pGun) add('handgun', 'waistband');
  if (record.gang !== null && unitHash(seed, SALT.itemBrass, id) < it.brassKnucklesIfGang) add('brassKnuckles', 'waistband');

  // Drugs and paraphernalia of the person's kind.
  const drug = drugItem(traits.drugUse);
  if (drug !== null && daily(SALT.itemDrugs) < it.drugsIfUser) add(drug, stash);
  const para = paraphernaliaItem(traits.drugUse);
  if (para !== null && daily(SALT.itemParaphernalia) < it.paraphernaliaIfUser) add(para, stash);

  if (daily(SALT.itemStolen) < riskRate(it.stolenGoodsIfRisk, traits.risk)) add('stolenGoods', stash);
  if (daily(SALT.itemCards) < riskRate(it.creditCardsIfRisk, traits.risk)) add('creditCards', 'pocket');
  return out;
}

/** The driver facts `vehicleItems` depends on. */
export interface VehicleDriver {
  readonly id: number;
  readonly drinker: number;
  readonly drugUse: DrugKind;
  readonly intoxicated: boolean;
  readonly weaponCarrier: boolean;
  readonly risk: number;
}

/**
 * Items inside registry vehicle `vehicleId` for its driver on `epochDay`: an open container (visible, when the
 * driver is intoxicated), liquor, drugs, a weapon under the seat, stolen goods and burglary tools.
 * Instance ids `v<vehicleId>:<item>:0`.
 */
export function vehicleItems(seed: number, vehicleId: number, epochDay: number, driver: VehicleDriver): CarriedItem[] {
  const v = PEOPLE_DATA.vehicleItems;
  const out: CarriedItem[] = [];
  const add = (item: string, where: CarriedItem['where'], visible = false): void => {
    out.push({ instance: `v${vehicleId}:${item}:0`, item, where, visible });
  };
  const daily = (salt: number): number => unitHash(seed, salt ^ epochDay, vehicleId);
  if (driver.intoxicated && daily(SALT.vehOpen) < v.openContainerIfDrinking) add('openContainer', 'cabin', true);
  if (daily(SALT.vehLiquor) < v.liquorBottleIfDrinker * driver.drinker) add('liquorBottle', 'underSeat');
  const drug = drugItem(driver.drugUse);
  if (drug !== null && daily(SALT.vehDrugs) < v.drugsIfUser) add(drug, 'glovebox');
  if (driver.weaponCarrier && unitHash(seed, SALT.vehWeapon, vehicleId) < v.weaponIfCarrier) {
    add(unitHash(seed, SALT.vehWeaponKind, vehicleId) < 0.7 ? 'handgun' : 'knife', 'underSeat');
  }
  if (unitHash(seed, SALT.vehStolen, vehicleId) < v.stolenGoods) add('stolenGoods', 'trunk');
  if (unitHash(seed, SALT.vehTools, vehicleId) < riskRate(v.burglaryToolsIfRisk, driver.risk)) add('burglaryTools', 'trunk');
  return out;
}
