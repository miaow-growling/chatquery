import React, { useState } from 'react';

export interface ReleaseFile {
  name: string;
  platform?: string;
  size?: string;
  sha256?: string;
  url: string;
}

export interface LatestReleaseInfo {
  version: string;
  tag: string;
  release_date?: string;
  platforms?: Record<string, ReleaseFile>;
  files?: ReleaseFile[];
}

export interface UpdateModalProps {
  currentVersion: string;
  releaseInfo: LatestReleaseInfo | null;
  onClose: () => void;
}

export const UpdateModal: React.FC<UpdateModalProps> = ({
  currentVersion,
  releaseInfo,
  onClose,
}) => {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  if (!releaseInfo) return null;

  const isMac = typeof navigator !== 'undefined' && /macintosh|mac os x/i.test(navigator.userAgent);
  const isWindows = typeof navigator !== 'undefined' && /windows|win32/i.test(navigator.userAgent);

  // 整理所有安装包文件（排除 SHA256SUMS 和 latest.json）
  const downloadFiles: ReleaseFile[] = (releaseInfo.files || []).filter(
    (f) => !f.name.endsWith('.txt') && !f.name.endsWith('.json')
  );

  // 推荐当前平台的首选文件
  let recommendedFile: ReleaseFile | undefined;
  if (isMac) {
    recommendedFile = downloadFiles.find((f) => f.name.endsWith('.dmg') || f.platform?.includes('macos'));
  } else if (isWindows) {
    recommendedFile = downloadFiles.find((f) => f.name.includes('setup.exe') || f.platform?.includes('installer'));
  }

  if (!recommendedFile && downloadFiles.length > 0) {
    recommendedFile = downloadFiles[0];
  }

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    });
  };

  const handleOpenDownload = (url: string) => {
    window.open(url, '_blank');
  };

  const formattedDate = releaseInfo.release_date
    ? new Date(releaseInfo.release_date).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal update-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <span className="modal-title-icon">🚀</span>
            <span>软件版本更新</span>
          </div>
          <button type="button" className="icon-btn modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="update-modal-body">
          {/* 版本对比横幅 */}
          <div className="update-version-banner">
            <div className="version-info-box">
              <span className="ver-label">当前版本</span>
              <span className="ver-val current">v{currentVersion}</span>
            </div>
            <div className="version-arrow">➔</div>
            <div className="version-info-box">
              <span className="ver-label">最新版本</span>
              <span className="ver-val latest">v{releaseInfo.version}</span>
            </div>
          </div>

          {formattedDate && (
            <div className="update-meta-time">
              <span>发布时间：{formattedDate}</span>
            </div>
          )}

          {/* 首选推荐下载入口 */}
          {recommendedFile && (
            <div className="recommended-download-card">
              <div className="rec-badge">
                {isMac ? '🍎 macOS 推荐' : isWindows ? '🪟 Windows 推荐' : '⭐ 推荐安装包'}
              </div>
              <div className="rec-content">
                <div className="rec-info">
                  <span className="rec-filename">{recommendedFile.name}</span>
                  {recommendedFile.size && (
                    <span className="rec-filesize">（{recommendedFile.size}）</span>
                  )}
                </div>
                <button
                  type="button"
                  className="primary-btn rec-btn"
                  onClick={() => handleOpenDownload(recommendedFile!.url)}
                >
                  立即下载安装包
                </button>
              </div>
            </div>
          )}

          {/* 所有可用平台下载列表 */}
          <div className="all-downloads-section">
            <div className="section-title">全平台安装包下载直链：</div>
            <div className="download-files-list">
              {downloadFiles.length > 0 ? (
                downloadFiles.map((file) => (
                  <div key={file.name} className="download-file-item">
                    <div className="file-item-left">
                      <span className="file-icon">
                        {file.name.endsWith('.dmg') ? '🍎' : file.name.endsWith('.exe') ? '🪟' : '📦'}
                      </span>
                      <div className="file-details">
                        <span className="file-name">{file.name}</span>
                        {file.size && <span className="file-size">{file.size}</span>}
                      </div>
                    </div>
                    <div className="file-item-actions">
                      <button
                        type="button"
                        className="sec-btn-sm"
                        onClick={() => handleCopy(file.url)}
                      >
                        {copiedUrl === file.url ? '✓ 已复制' : '复制链接'}
                      </button>
                      <button
                        type="button"
                        className="primary-btn-sm"
                        onClick={() => handleOpenDownload(file.url)}
                      >
                        下载
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="no-files-hint">未找到该版本的安装包文件。</div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="sec-btn" onClick={onClose}>
            关闭
          </button>
          {recommendedFile && (
            <button
              type="button"
              className="primary-btn"
              onClick={() => handleOpenDownload(recommendedFile!.url)}
            >
              在浏览器中打开下载
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
