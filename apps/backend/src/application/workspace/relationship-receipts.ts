import {
  boardDeleteReceipt, checklistDeleteReceipt, fieldCommands, fieldDefinitionDeleteReceipt, fieldGroupDeleteReceipt,
  labelDeleteReceipt, listDeleteReceipt, relationshipCommands, removedComment, removedRelationship, taskDeleteReceipt,
  type RelationshipCommand,
} from '@planner/contracts';

export function relationshipDeletionSummary(operation: RelationshipCommand, result: unknown): {
  parentRevision?: number; removedGroups?: number; removedValues?: number;
} {
  switch (operation) {
    case 'boards.delete': return { parentRevision: boardDeleteReceipt.parse(result).data.parentRevision };
    case 'lists.delete': return { parentRevision: listDeleteReceipt.parse(result).data.parentRevision };
    case 'labels.delete': return { parentRevision: labelDeleteReceipt.parse(result).data.parentRevision };
    case 'checklists.delete': return { parentRevision: checklistDeleteReceipt.parse(result).data.parentRevision };
    case 'fields.deleteGroup': {
      const { parentRevision, removedGroups, removedValues } = fieldGroupDeleteReceipt.parse(result).data;
      return { parentRevision, removedGroups, removedValues };
    }
    case 'fields.delete': return { parentRevision: fieldDefinitionDeleteReceipt.parse(result).data.parentRevision };
    case 'fields.clearValue': return { parentRevision: fieldCommands[operation].output.parse(result).data.revision };
    case 'comments.delete': return { parentRevision: removedComment.parse(result).data.cardRevision };
    case 'tasks.delete': return { parentRevision: taskDeleteReceipt.parse(result).data.checklist.revision };
    default: {
      if (relationshipCommands[operation].target !== 'edge') return {};
      const { parentRevision } = removedRelationship.parse(result).data;
      return parentRevision === null ? {} : { parentRevision };
    }
  }
}
