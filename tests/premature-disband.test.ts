import { expect, it } from 'vitest'
import { isWorkflowCommand } from '../lib/managed-workflow'

it.each([
  'Eerste lezing summary.ts klaar; nu tests, schema, restic-hook',
  'Systematische vergelijking klaar. De vier workers op een rij.',
  'Ik ben klaar. Geen openstaande punten meer.',
  'Status update after <<COLLAB_DONE>>',
])('keeps natural-language status out of the finalization protocol (%s)', content => {
  expect(isWorkflowCommand(content)).toBe(false)
})
