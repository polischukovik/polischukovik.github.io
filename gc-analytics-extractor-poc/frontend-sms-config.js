// config/smsCost/config.js

// Pricing data from https://help.genesys.cloud/articles/sms-monthly-recurring-pricing/
// Using USD as the currency.
const MRP_PRICING_USD = {
    "A": 1.25,
    "B": 2.50,
    "C": 1.25,
    "D": 3.75,
    "E": 6.25,
    "F": 7.50,
    "G": 12.50,
    "H": 18.00,
    "I": 35.00,
    "J": 93.75
};

const INBOUND_SMS_PRICING_USD = {
  'A': 0.01,
  'B': 0.01,
  'D': 0.05,
  'C': 0.03,
  'E': 0.06
};

const OUTBOUND_SMS_PRICING_USD = {
  'A': 0.01,
  'B': 0.0125,
  'O': 0.2,
  'L': 0.12,
  'K': 0.11,
  'Q': 0.4,
  'G': 0.07,
  'N': 0.15,
  'M': 0.13,
  'F': 0.06,
  'E': 0.05,
  'P': 0.3,
  'C': 0.03,
  'UNKNOWN': 0.03,
  'H': 0.08,
  'I': 0.09,
  'D': 0.04,
  '0': 0.2,
  'J': 0.1
};

// Mapping from country and type to rate class (using 2-character country codes)
const countryTypeToRateClass = {
    "US": { "local": "A", "mobile": "A", "tollfree": "B" },
    "CA": { "local": "A", "mobile": "A", "tollfree": "B" },
    "AU": { "default": "F" },
    "AT": { "default": "F" },
    "BE": { "default": "C" },
    "CL": { "default": "G" },
    "HR": { "default": "F" },
    "CZ": { "default": "H" },
    "DK": { "default": "H" },
    "EE": { "default": "D" },
    "FR": { "default": "D" },
    "DE": { "default": "E" },
    "HK": { "default": "H" },
    "HU": { "default": "I" },
    "IE": { "default": "F" },
    "IL": { "default": "H" },
    "IT": { "default": "I" },
    "LT": { "default": "D" },
    "MY": { "default": "E" },
    "NL": { "default": "E" },
    "PL": { "default": "D" },
    "PT": { "default": "H" },
    "PR": { "default": "D" },
    "SG": { "default": "J" },
    "ES": { "default": "E" },
    "CH": { "default": "G" },
    "GB": { "default": "C" }
};

const numberToDivisionMap = {};

export {
    MRP_PRICING_USD,
    countryTypeToRateClass,
    numberToDivisionMap,
    INBOUND_SMS_PRICING_USD,
    OUTBOUND_SMS_PRICING_USD,
    countryTypeToRateClassInbound,
    countryTypeToRateClassOutbound,
};
