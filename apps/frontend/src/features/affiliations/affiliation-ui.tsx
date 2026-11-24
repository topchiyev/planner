import type { CSSProperties } from 'react';
import { labelColorSchema, type LabelColor, type WorkspaceReadOutput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { useWorkspaceMutation } from '../projects/project-controls.js';
import './affiliations.css';

type Label = WorkspaceReadOutput<'boardLabels'>['data'][number];
export type { Label };

const colors: Record<LabelColor, string> = {
  'muddy-grey': '#756c64', 'autumn-leafs': '#a45239', 'morning-sky': '#5688b6', 'antique-blue': '#515f97',
  'egg-yellow': '#b99023', 'desert-sand': '#ad8059', 'dark-granite': '#454d55', 'fresh-salad': '#597942',
  'lagoon-blue': '#198098', 'midnight-blue': '#334568', 'light-orange': '#bf6e40', 'pumpkin-orange': '#b85c22',
  'light-concrete': '#77817c', 'sunny-grass': '#688322', 'navy-blue': '#34486f', 'lilac-eyes': '#8c6baf',
  'apricot-red': '#b66360', 'orange-peel': '#c7832b', 'silver-glint': '#697b8c', 'bright-moss': '#4d814b',
  'deep-ocean': '#3c6680', 'summer-sky': '#3e81b0', 'berry-red': '#aa435a', 'light-cocoa': '#896949',
  'grey-stone': '#6e7078', 'tank-green': '#596642', 'coral-green': '#4a8867', 'sugar-plum': '#7d527f',
  'pink-tulip': '#a55882', 'shady-rust': '#8d4e41', 'wet-rock': '#5e6970', 'wet-moss': '#4e705d',
  'turquoise-sea': '#27887e', 'lavender-fields': '#7768a6', 'piggy-red': '#c47178', 'light-mud': '#a6886c',
  'gun-metal': '#505761', 'modern-green': '#398373', 'french-coast': '#5677a5', 'sweet-lilac': '#976691',
  'red-burgundy': '#77384b', 'pirate-gold': '#a77825',
};

export function labelColorName(value: string) {
  return value.split('-').map((word, index) => index ? word : word[0].toUpperCase() + word.slice(1)).join(' ');
}

export function labelName(label: Pick<Label, 'name' | 'color'>) {
  const color = labelColorSchema.safeParse(label.color).data;
  return label.name || (color ? labelColorName(color) : 'Unnamed label');
}

export function LabelChip({ label }: { label: Pick<Label, 'name' | 'color'> }) {
  const color = labelColorSchema.safeParse(label.color).data;
  const style = { '--palette-color': color ? colors[color] : '#65726e' } as CSSProperties;
  return <span className="planner-label" style={style}>{labelName(label)}</span>;
}

const errors = new Map([
  ['INELIGIBLE_ACCOUNT', 'Choose an active member of this board.'],
  ['LABEL_ORDER_CONFLICT', 'The palette order changed. Review it and try again.'],
  ['REVISION_CONFLICT', 'This item changed. Review the current information and try again.'],
]);

export function useAffiliationMutation() {
  return useWorkspaceMutation(errors, 'This item or your access changed. Review the current information and try again.',
    'Check the label or board member and try again.');
}

export function PersonalFollow({ resource, id, revision, following, automatic = false }: {
  resource: 'board' | 'card'; id: string; revision: number; following: boolean; automatic?: boolean;
}) {
  const action = useAffiliationMutation();
  function change(follow: boolean) {
    const operation = `${resource}s.${follow ? 'follow' : 'unfollow'}` as const;
    void action.run([operation, id, revision], (csrf, key) => relationshipCommand(operation, csrf, key, { id, revision }));
  }
  return <div className="personal-follow">
    <div className="project-actions">
      <button className="workspace-button" type="button" disabled={action.busy} onClick={() => change(!following)}>
        {following ? 'Unfollow ' : 'Follow '}{resource}
      </button>
      {following && automatic && <button className="workspace-button" type="button" disabled={action.busy}
        onClick={() => change(true)}>Keep following {resource}</button>}
    </div>
    {action.problem && <p role="alert" className="workspace-problem">{action.problem}</p>}
  </div>;
}
