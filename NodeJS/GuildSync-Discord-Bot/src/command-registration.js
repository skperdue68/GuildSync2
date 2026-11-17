// Discord returns subcommands as application command options of type 1 and
// arguments as other types, so the type is what separates a subcommand from an
// argument.
const SUBCOMMAND_TYPE = 1;

// The fields that change what a member can type. Localizations and choices are
// excluded: they do not change the shape this build registers.
const OPTION_FIELDS = ['type', 'required', 'description', 'min_value', 'max_value', 'min_length', 'max_length'];

const normalizeText = (value) => String(value ?? '').trim();

const normalizeNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const fieldsOf = (command = {}) => (Array.isArray(command?.options) ? command.options : []);

const subcommandsOf = (command = {}) => fieldsOf(command).filter((option) => Number(option?.type) === SUBCOMMAND_TYPE);

export function subcommandNames(command = {}) {
  return subcommandsOf(command).map((option) => normalizeText(option.name)).filter(Boolean);
}

function fieldValue(field, option = {}) {
  switch (field) {
    case 'type':
      return normalizeNumber(option.type);
    case 'required':
      // Discord omits required when it is false, so absence means false.
      return Boolean(option.required);
    case 'description':
      return normalizeText(option.description);
    default:
      return normalizeNumber(option[field]);
  }
}

const describeValue = (value) => {
  if (value === null) return 'not set';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return `“${value}”`;
};

/**
 * Every difference that would give a member different input than this build
 * declares, named option by option.
 *
 * Comparing names alone is what let a stale `/trader sales` keep passing while
 * the new count option was missing, so the requirement, type, wording and limits
 * of each option are compared too.
 */
export function optionDifferences(registered, expected) {
  const differences = [];
  const registeredOptions = new Map(fieldsOf(registered).map((option) => [normalizeText(option.name), option]));
  const expectedOptions = fieldsOf(expected);

  for (const option of expectedOptions) {
    const name = normalizeText(option.name);
    const actual = registeredOptions.get(name);

    if (!actual) {
      differences.push(`missing the ${name} option`);
      continue;
    }

    for (const field of OPTION_FIELDS) {
      const actualValue = fieldValue(field, actual);
      const expectedValue = fieldValue(field, option);
      if (actualValue === expectedValue) continue;

      differences.push(
        `${name} ${field} is ${describeValue(actualValue)} here but ${describeValue(expectedValue)} in this build`
      );
    }
  }

  for (const name of registeredOptions.keys()) {
    if (!expectedOptions.some((option) => normalizeText(option.name) === name)) {
      differences.push(`has an unexpected ${name} option`);
    }
  }

  return differences;
}

/**
 * Why a registered /trader is not the one this build declares.
 *
 * `expected` is the local command definition (with its subcommands and their
 * options), not a list of names: a subcommand whose options drifted is as stale
 * as one that is missing.
 */
export function staleTraderReasons(command, expected) {
  if (!command) return ['it is not registered'];

  const expectedSubcommands = subcommandsOf(expected);
  const registeredSubcommands = new Map(subcommandsOf(command).map((option) => [normalizeText(option.name), option]));
  const expectedNames = new Set(expectedSubcommands.map((option) => normalizeText(option.name)));
  const reasons = [];

  // Reported separately: leaving the retired subcommand in place is the specific
  // mistake this check exists to catch.
  if (registeredSubcommands.has('test') && !expectedNames.has('test')) {
    reasons.push('it still offers the retired /trader test');
  }

  for (const option of expectedSubcommands) {
    const name = normalizeText(option.name);
    const registered = registeredSubcommands.get(name);

    if (!registered) {
      reasons.push(`it is missing /trader ${name}`);
      continue;
    }

    const differences = optionDifferences(registered, option);
    if (differences.length) reasons.push(`/trader ${name} does not match: ${differences.join(', ')}`);
  }

  for (const name of registeredSubcommands.keys()) {
    if (expectedNames.has(name) || name === 'test') continue;
    reasons.push(`it has an unexpected /trader ${name}`);
  }

  return reasons;
}
