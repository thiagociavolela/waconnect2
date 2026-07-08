import { DateTime } from "luxon";

export const APP_TIMEZONE = "America/Sao_Paulo";
export const APP_LOCALE = "pt-BR";
export const APP_TIMEZONE_OFFSET = "-03:00";

const EXPLICIT_ZONE_PATTERN = /(Z|[+-]\d{2}:\d{2})$/i;
const TRAILING_ZONE_SUFFIX_PATTERN = /(Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/i;

export function parseAppDateTime(value: string): DateTime {
  const input = value.trim();
  const parsers = EXPLICIT_ZONE_PATTERN.test(input)
    ? [
        () => DateTime.fromISO(input, { setZone: true, locale: APP_LOCALE }),
        () => DateTime.fromSQL(input, { setZone: true, locale: APP_LOCALE })
      ]
    : [
        () => DateTime.fromISO(input, { zone: APP_TIMEZONE, locale: APP_LOCALE }),
        () => DateTime.fromSQL(input, { zone: APP_TIMEZONE, locale: APP_LOCALE })
      ];

  for (const parse of parsers) {
    const dt = parse();
    if (dt.isValid) {
      return dt.setZone(APP_TIMEZONE);
    }
  }

  throw new Error("Data/hora inválida.");
}

export function parseAppWallClockDateTime(value: string): DateTime {
  const input = value.trim().replace(TRAILING_ZONE_SUFFIX_PATTERN, "");
  const parsers = [
    () => DateTime.fromISO(input, { zone: APP_TIMEZONE, locale: APP_LOCALE }),
    () => DateTime.fromSQL(input, { zone: APP_TIMEZONE, locale: APP_LOCALE }),
    () => DateTime.fromFormat(input, "yyyy-MM-dd'T'HH:mm:ss.SSS", { zone: APP_TIMEZONE, locale: APP_LOCALE }),
    () => DateTime.fromFormat(input, "yyyy-MM-dd'T'HH:mm:ss", { zone: APP_TIMEZONE, locale: APP_LOCALE }),
    () => DateTime.fromFormat(input, "yyyy-MM-dd'T'HH:mm", { zone: APP_TIMEZONE, locale: APP_LOCALE }),
    () => DateTime.fromFormat(input, "yyyy-MM-dd HH:mm:ss.SSS", { zone: APP_TIMEZONE, locale: APP_LOCALE }),
    () => DateTime.fromFormat(input, "yyyy-MM-dd HH:mm:ss", { zone: APP_TIMEZONE, locale: APP_LOCALE }),
    () => DateTime.fromFormat(input, "yyyy-MM-dd HH:mm", { zone: APP_TIMEZONE, locale: APP_LOCALE })
  ];

  for (const parse of parsers) {
    const dt = parse();
    if (dt.isValid) {
      return dt.setZone(APP_TIMEZONE);
    }
  }

  throw new Error("Data/hora inválida.");
}

export function nowApp(): DateTime {
  return DateTime.now().setZone(APP_TIMEZONE);
}

export function appDateTimeToMysql(value: DateTime): string {
  return value.setZone(APP_TIMEZONE).toFormat("yyyy-MM-dd HH:mm:ss.SSS");
}

export function mysqlAppToIso(value: string): string {
  const dt = DateTime.fromSQL(value, { zone: APP_TIMEZONE, locale: APP_LOCALE });
  return dt.toISO({ suppressMilliseconds: false }) ?? dt.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZ");
}

export function subtractMilliseconds(value: DateTime, milliseconds: number): DateTime {
  return value.minus({ milliseconds });
}
