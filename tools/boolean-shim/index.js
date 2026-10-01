'use strict';

// Verhalten wie boolean@3: Strings wie "true", "t", "yes", "y", "on", "1" sowie die Zahl 1 sind wahr.
const TRUE = /^(true|t|yes|y|on|1)$/i;
const FALSE = /^(false|f|no|n|off|0)$/i;

function boolean(value) {
  switch (Object.prototype.toString.call(value)) {
    case '[object String]':
      return TRUE.test(value.trim());
    case '[object Number]':
      return value.valueOf() === 1;
    case '[object Boolean]':
      return value.valueOf();
    default:
      return false;
  }
}

function isBooleanable(value) {
  switch (Object.prototype.toString.call(value)) {
    case '[object String]':
      return TRUE.test(value.trim()) || FALSE.test(value.trim());
    case '[object Number]':
      return [0, 1].includes(value.valueOf());
    case '[object Boolean]':
      return true;
    default:
      return false;
  }
}

module.exports = { boolean, isBooleanable };
