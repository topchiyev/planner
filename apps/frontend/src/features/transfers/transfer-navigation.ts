import type { RelationshipCommandOutput } from '@planner/contracts';
import { boardHref } from '../workspace/workspace-navigation.js';

type MoveResult = RelationshipCommandOutput<'cards.move'>['data'];
type Remaps = NonNullable<MoveResult['remaps']>;

export function transferredCardHref(card: MoveResult['card']) {
  return boardHref(card.boardId) + '/cards/' + card.id + (card.kind === 'board' ? '' : '?context=' + card.kind);
}

export function transferNotice(action: string, remaps?: Remaps) {
  if (!remaps) return action;
  const counts = [
    [remaps.labelsRemapped, 'labels remapped'], [remaps.labelsCreated, 'labels created'],
    [remaps.removedAssignees, 'assignments removed'], [remaps.removedFollows, 'follows removed'],
    [remaps.clearedTaskAssignees, 'task assignments cleared'], [remaps.fieldGroupsMaterialized, 'field groups remapped'],
  ] as const;
  const changes = counts.filter(([count]) => count > 0).map(([count, label]) => count + ' ' + label);
  return changes.length ? action + ' ' + changes.join(', ') + '.' : action;
}
