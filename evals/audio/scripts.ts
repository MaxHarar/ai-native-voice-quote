// Caller scripts for the audio-level eval. Each line is spoken only when the agent's latest turn
// matches its `when` prompt, so the caller answers the question actually asked. All data is
// invented (names, dates, license numbers); ZIPs are NJ (07xxx-08xxx) or PA (15xxx-19xxx).

import type { Line } from "./match";

export type Slots = Record<string, string | number | boolean>;

export interface Script {
  id: string;
  description: string;
  lines: Line[];
  /** Expected params of the LAST call of each tool (get_quote: {} means "must be called"). */
  expected: Record<string, Slots>;
  /** Tools that must not be called (the caller declines to submit). */
  forbidTools: string[];
}

// Agent prompt patterns, shared across scripts. Kept broad enough to survive rephrasing and
// narrow enough not to collide with neighbouring questions (lookahead is limited to 4 lines).
const P = {
  name: /first and last name|your (full )?name/i,
  zip: /\bzip\b/i,
  insuredNow: /insurance|insured/i,
  months: /months|how long have you (had|been)|continuous/i,
  dob: /date of birth|birthday|when were you born/i,
  licState: /which state|what state|state (issued|is your license)/i,
  handy: /license handy|have your (driver'?s )?license (with you|on you|handy|nearby)/i,
  licNumber: /digits|license number|number when you'?re ready|read (me )?(it|them|the number)/i,
  readback: /is that (right|correct)|did i get (that|it) right|(right|correct)\?|have that right/i,
  years: /how (many|long).{0,40}(licensed|driving|had (your|a) license)|years.{0,20}licensed/i,
  tickets: /ticket/i,
  accidents: /accident/i,
  dui: /\bdui\b|\bdwi\b/i,
  others: /anyone else|other drivers?|household/i,
  vin: /\bvin\b/i,
  ymm: /year,? make|make,? and model|what (kind of )?(car|vehicle)/i,
  usage: /getting to work|personal use|commut|mostly for/i,
  rideshare: /rideshare|deliver|part of your job/i,
  miles: /miles/i,
  moreVehicles: /other (vehicles?|cars?)|another (vehicle|car)|any more (vehicles|cars)/i,
  pkg: /package|minimum|recommended/i,
  tort: /\btort\b/i,
  pay: /pay in full|monthly|all at once/i,
  submit: /submit|application/i,
  bye: /anything else|else i can help/i,
};
const NOT_MONTHS = /months|how long|continuous/i;
const NOT_DIGITS = /digits|read me|ready/i;

export const CHECKIN_REPLY = "Yes, I'm still here.";

export const SCRIPTS: Script[] = [
  {
    id: "happy-path-pa",
    description: "Short PA happy path through get_quote; license read in groups; declines to submit.",
    lines: [
      { id: "name", say: "Jordan Ellis.", when: P.name },
      { id: "zip", say: "One eight nine four zero.", when: P.zip },
      { id: "insured", say: "Yes, I do.", when: P.insuredNow, unless: NOT_MONTHS, optional: true },
      { id: "months", say: "About thirty-six months.", when: P.months },
      { id: "dob", say: "March fourteenth, nineteen ninety-one.", when: P.dob },
      { id: "lic_state", say: "Pennsylvania.", when: P.licState },
      { id: "lic_handy", say: "Yes, I have it right here.", when: P.handy, unless: NOT_DIGITS, optional: true },
      { id: "lic_number", say: "One two three four, five six seven eight.", when: P.licNumber },
      { id: "readback", say: "Yes, that's right.", when: P.readback },
      { id: "years", say: "Fifteen years.", when: P.years },
      { id: "tickets", say: "No tickets.", when: P.tickets },
      { id: "accidents", say: "No accidents.", when: P.accidents },
      { id: "dui", say: "No.", when: P.dui },
      { id: "others", say: "No, just me.", when: P.others },
      { id: "vin", say: "Not handy, no.", when: P.vin, optional: true },
      { id: "ymm", say: "It's a twenty fifteen BMW five thirty-five i.", when: P.ymm },
      { id: "usage", say: "Mostly for commuting to work.", when: P.usage },
      { id: "rideshare", say: "No, never.", when: P.rideshare, optional: true },
      { id: "miles", say: "About fifteen thousand miles a year.", when: P.miles },
      { id: "more_vehicles", say: "No, that's the only one.", when: P.moreVehicles, optional: true },
      { id: "package", say: "The minimum package, please.", when: P.pkg },
      { id: "tort", say: "Limited tort.", when: P.tort },
      { id: "pay", say: "Monthly.", when: P.pay },
      { id: "submit", say: "No thanks, not today.", when: P.submit },
      { id: "bye", say: "No, that's all. Thanks, goodbye.", when: P.bye, optional: true },
    ],
    expected: {
      start_quote: { caller_name: "Jordan Ellis", zip: "18940", prior_insurance_months: 36 },
      save_driver: {
        driver_index: 1, first_name: "Jordan", last_name: "Ellis", date_of_birth: "1991-03-14", license_state: "PA",
        license_number: "12345678", years_licensed: 15, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false,
      },
      save_vehicle: { vehicle_index: 1, year: 2015, make: "BMW", model: "535i", usage: "commute", annual_miles: 15000 },
      set_coverage: { package: "minimum", pay_in_full: false, tort_option: "limited" },
      get_quote: {},
    },
    forbidTools: ["submit_application"],
  },
  {
    id: "short-answers",
    description: "PA path answered almost entirely in one-word replies (the live ASR-drop failure class).",
    lines: [
      { id: "name", say: "Dana Brooks.", when: P.name },
      { id: "zip", say: "One nine one zero three.", when: P.zip },
      { id: "insured", say: "Yes.", when: P.insuredNow, unless: NOT_MONTHS, optional: true },
      { id: "months", say: "Twelve.", when: P.months },
      { id: "dob", say: "July second, nineteen eighty-eight.", when: P.dob },
      { id: "lic_state", say: "Pennsylvania.", when: P.licState },
      { id: "lic_handy", say: "Yes.", when: P.handy, unless: NOT_DIGITS, optional: true },
      { id: "lic_number", say: "Eight seven six five, four three two one.", when: P.licNumber },
      { id: "readback", say: "Yes.", when: P.readback },
      { id: "years", say: "Five.", when: P.years },
      { id: "tickets", say: "One.", when: P.tickets },
      { id: "accidents", say: "Zero.", when: P.accidents },
      { id: "dui", say: "No.", when: P.dui },
      { id: "others", say: "No.", when: P.others },
      { id: "vin", say: "No.", when: P.vin, optional: true },
      { id: "ymm", say: "Twenty eighteen Honda Civic.", when: P.ymm },
      { id: "usage", say: "Work.", when: P.usage },
      { id: "rideshare", say: "No.", when: P.rideshare, optional: true },
      { id: "miles", say: "Ten thousand.", when: P.miles },
      { id: "more_vehicles", say: "No.", when: P.moreVehicles, optional: true },
      { id: "package", say: "Recommended.", when: P.pkg },
      { id: "tort", say: "Full.", when: P.tort },
      { id: "pay", say: "Monthly.", when: P.pay },
      { id: "submit", say: "No.", when: P.submit },
      { id: "bye", say: "No. Bye.", when: P.bye, optional: true },
    ],
    expected: {
      start_quote: { caller_name: "Dana Brooks", zip: "19103", prior_insurance_months: 12 },
      save_driver: {
        driver_index: 1, first_name: "Dana", last_name: "Brooks", date_of_birth: "1988-07-02", license_state: "PA",
        license_number: "87654321", years_licensed: 5, tickets_3y: 1, at_fault_accidents_3y: 0, dui_3y: false,
      },
      save_vehicle: { vehicle_index: 1, year: 2018, make: "Honda", model: "Civic", usage: "commute", annual_miles: 10000 },
      set_coverage: { package: "recommended", pay_in_full: false, tort_option: "full" },
      get_quote: {},
    },
    forbidTools: ["submit_application"],
  },
  {
    id: "yes-after-readback",
    description: "NJ path where the caller confirms the license read-back with a bare 'Yes. Yes.' (the live 9 s silence).",
    lines: [
      { id: "name", say: "Sam Russo.", when: P.name },
      { id: "zip", say: "Zero eight five four zero.", when: P.zip },
      { id: "insured", say: "Yes.", when: P.insuredNow, unless: NOT_MONTHS, optional: true },
      { id: "months", say: "Twenty-four months.", when: P.months },
      { id: "dob", say: "December ninth, nineteen ninety-five.", when: P.dob },
      { id: "lic_state", say: "New Jersey.", when: P.licState },
      { id: "lic_handy", say: "Yes.", when: P.handy, unless: NOT_DIGITS, optional: true },
      { id: "lic_number", say: "R, one two three four, five six seven eight nine, one two three four five.", when: P.licNumber },
      { id: "readback", say: "Yes. Yes.", when: P.readback },
      { id: "years", say: "Eight years.", when: P.years },
      { id: "tickets", say: "No tickets.", when: P.tickets },
      { id: "accidents", say: "No.", when: P.accidents },
      { id: "dui", say: "No.", when: P.dui },
      { id: "others", say: "No.", when: P.others },
      { id: "vin", say: "No.", when: P.vin, optional: true },
      { id: "ymm", say: "A twenty twenty Toyota Camry.", when: P.ymm },
      { id: "usage", say: "Commuting.", when: P.usage },
      { id: "rideshare", say: "No.", when: P.rideshare, optional: true },
      { id: "miles", say: "Twelve thousand.", when: P.miles },
      { id: "more_vehicles", say: "No.", when: P.moreVehicles, optional: true },
      { id: "package", say: "Recommended.", when: P.pkg },
      { id: "pay", say: "Pay in full.", when: P.pay },
      { id: "submit", say: "No, not right now.", when: P.submit },
      { id: "bye", say: "No, that's it. Bye.", when: P.bye, optional: true },
    ],
    expected: {
      start_quote: { caller_name: "Sam Russo", zip: "08540", prior_insurance_months: 24 },
      save_driver: {
        driver_index: 1, first_name: "Sam", last_name: "Russo", date_of_birth: "1995-12-09", license_state: "NJ",
        license_number: "R12345678912345", years_licensed: 8, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false,
      },
      save_vehicle: { vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 12000 },
      set_coverage: { package: "recommended", pay_in_full: true },
      get_quote: {},
    },
    forbidTools: ["submit_application"],
  },
];

export const scriptById = (id: string) => SCRIPTS.find((s) => s.id === id);
