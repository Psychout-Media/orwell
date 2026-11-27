/**
 * ORW-1033: what the player's words are, for every intent parser (move, person, own bed, bed claim): the text with the parts that are NOT the player's own act taken out - double and
 * single quoted speech, and out-of-character asides in double parentheses ("((should I go to the lounge))"). Pure.
 */
export function stripNonActs(text: string): string {
  return String(text ?? "")
    .replace(/\(\([\s\S]*?\)\)/g, " ")
    .replace(/"[^"]*"/g, " . ")
    .replace(/“[^”]*”/g, " . ")
    .replace(/(^|[\s(\[])[\u2018']((?:[^'\u2018\u2019\n]|['\u2019](?=[A-Za-z])){2,}?)[\u2019'](?=$|[\s.,!?;:)\]])/g, "$1 ") // 'see you later' or 'let's go': an apostrophe inside a word ("I'll", "Dana's") never opens or closes a quote
    .replace(/\s+/g, " ");
}
