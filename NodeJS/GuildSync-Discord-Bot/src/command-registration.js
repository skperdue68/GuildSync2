// Discord returns subcommands as application command options of type 1, and
// string options (like /trader sales item) as type 3, so the type is what
// separates a subcommand from an argument.
const SUBCOMMAND_TYPE = 1;

export function subcommandNames(command = {}) {
  return (Array.isArray(command?.options) ? command.options : [])
    .filter((option) => Number(option?.type) === SUBCOMMAND_TYPE)
    .map((option) => String(option.name || '').trim())
    .filter(Boolean);
}

/**
 * Why a registered /trader is not the one this build declares.
 *
 * The retired `/trader test` is called out separately because leaving it in
 * place is the specific mistake this check exists to catch; a subcommand that is
 * missing means the registration did not land.
 */
export function staleTraderReasons(command, expected = []) {
  if (!command) return ['it is not registered'];

  const names = subcommandNames(command);
  const reasons = [];

  if (names.includes('test')) reasons.push('it still offers the retired /trader test');

  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length) reasons.push(`it is missing ${missing.map((name) => `/trader ${name}`).join(', ')}`);

  return reasons;
}
