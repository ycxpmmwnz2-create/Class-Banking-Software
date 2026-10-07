import process from 'node:process'
import { qualificationStatus } from './capabilities.js'
// Public code-capability status only: no data reader, file, environment, credential
// or platform client is loaded. This command cannot run a report or a live scan.
if (process.argv.slice(2).length) {
  process.stderr.write('Qualification status accepts no arguments.\n')
  process.exitCode = 2
} else {
  process.stdout.write(JSON.stringify(qualificationStatus()) + '\n')
}
