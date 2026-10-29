// Entry point: starts the bot, then testers, and keeps the test running until Ctrl+C.
// Run with: node run.js [--continuous] [--count N]
// --count N (or -n N) starts only the first N testers; the bot always runs.
import { startBotSession } from './bot.js';
import { AUTH_DIR, exitCleanlyOnCtrlC, isEntryPoint, loadConfig, stopAllClients } from './lib.js';
import { SelectionError, describeSelection, hasSavedSession, parseRunArgs, testerIds } from './session-selection.js';
import { runTests, testersFromArgs } from './tester.js';

// testerIds: explicit tester ids to start (profiles); null starts every configured tester.
// groupName: the warm-up group for the bot and the testers (a profile's group); null = config.groupName.
export async function runAll({ continuous = false, testerIds: onlyIds = null, groupName = null } = {}) {
  let shutdownStarted = false;

  try {
    const ids = onlyIds ?? testerIds(loadConfig(['testers']).testers);
    if (onlyIds) {
      for (const line of describeSelection(ids, (id) => hasSavedSession(AUTH_DIR, id))) console.log(line);
      console.log('');
    }

    console.log('Step 1/2: starting the bot (link it with the pairing code if one appears)\n');
    const { client: botClient, groupId, groupName: resolvedGroup } = await startBotSession({ groupName });

    console.log('\nStep 2/2: starting the testers (link them with the pairing codes if they appear)\n');
    await runTests({ botClient, testerIds: onlyIds, groupName: resolvedGroup, groupId });
  } catch (error) {
    console.error(error instanceof SelectionError ? error.message : error?.stack || error?.message || error);
    process.exitCode = 1;
  } finally {
    if (!shutdownStarted) {
      shutdownStarted = true;
      // In finite mode, let the bot answer the final message before closing.
      if (!continuous) {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
      await stopAllClients();
    }
  }
}

if (isEntryPoint(import.meta.url)) {
  exitCleanlyOnCtrlC();

  let selected = null;
  try {
    const picked = testersFromArgs(process.argv.slice(2), loadConfig(['testers']).testers);
    selected = picked && testerIds(picked);
  } catch (error) {
    console.error(error instanceof SelectionError ? error.message : error?.message || error);
    process.exit(1);
  }

  await runAll({
    continuous: process.argv.includes('--continuous'),
    testerIds: selected,
    groupName: parseRunArgs(process.argv.slice(2)).group,
  });
}
