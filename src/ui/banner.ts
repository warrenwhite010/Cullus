import chalk from "chalk";

export function renderBanner() {
  const sparkle = chalk.hex("#FF69B4")("✨");
  const title = chalk.hex("#DA70D6").bold("  ASSISTANT CLI  ");
  
  console.clear();
  console.log("\n");
  console.log(`  ${sparkle} ${title} ${sparkle}`);
  console.log(chalk.hex("#9370DB")("  ────────────────────────────────────────"));
  console.log(chalk.hex("#D8BFD8")("  Your aesthetic local intelligence companion."));
  console.log(chalk.hex("#D8BFD8")("  Type /help for commands or start typing below.\n"));
}