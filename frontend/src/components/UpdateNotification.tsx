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
    <div className="sidebar-update-banner" title={`发现新版本 v${latestVersion}，点击查看更新`}>
      <div className="update-banner-main" onClick={onOpenModal}>
        <span className="update-banner-icon">🚀</span>
        <div className="update-banner-text">
          <span className="update-title">发现新版本</span>
          <span className="update-ver-tag">v{latestVersion}</span>
        </div>
        <button
          type="button"
          className="update-action-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpenModal();
          }}
        >
          立即更新
        </button>
      </div>
      <button
        type="button"
        className="update-dismiss-btn"
        title="稍后提醒"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
      >
        ×
      </button>
    </div>
  );
};
