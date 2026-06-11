import React from 'react';

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  actionButton?: React.ReactNode;
}

export default function EmptyState({ icon = '📭', title, description, actionButton }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-gray-400">
      <span className="text-4xl mb-4">{icon}</span>
      <p className="text-lg font-medium text-gray-500 mb-1">{title}</p>
      {description && <p className="text-sm mb-4">{description}</p>}
      {actionButton}
    </div>
  );
}
