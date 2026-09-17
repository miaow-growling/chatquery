import React from 'react';

export interface UpdateNotificationProps {
  latestVersion: string;
  currentVersion: string;
  onOpenModal: () => void;
  onDismiss: () => void;
}

export const UpdateNotification: React.FC<UpdateNotificationProps> = ({
  latestVersion,
  onOpenModal,
  onDismiss,
}) => {
  return (
    <div className="sidebar-update-card" onClick={onOpenModal}>
      <div className="update-card-header">
        <div className="update-card-tag">
          <span className="update-rocket">🚀</span>
          <span className="update-title">发现新版本</span>
          <span className="update-badge">v{latestVersion}</span>
        </div>
        <button
          type="button"
          className="update-close-btn"
          title="稍后提醒"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          ×
        </button>
      </div>
      <div className="update-card-body">
        <button
          type="button"
          className="update-btn-primary"
          onClick={(e) => {
            e.stopPropagation();
            onOpenModal();
          }}
        >
          立即更新 ➔
        </button>
      </div>
    </div>
  );
};
