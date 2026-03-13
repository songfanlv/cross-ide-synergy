/**
 * 协同编辑通信协议 - 消息类型定义
 * 所有通过 WebSocket 传输的消息均以 JSON 编码
 */

// ---- 消息类型枚举 ----
export enum MessageType {
    /** 文档内容变更 */
    CHANGE = 'change',
    /** 光标位置同步 */
    CURSOR = 'cursor',
    /** 初始全文同步（Guest 加入时由 Host 下发） */
    FULL_SYNC = 'full_sync',
    /** Guest 请求全文同步 */
    REQUEST_SYNC = 'request_sync',
    /** 通用通知（加入/离开等） */
    NOTIFICATION = 'notification',
    /** 初始化工作区同步（发送所有打开的文件） */
    WORKSPACE_SYNC = 'workspace_sync',
    /** 远程打开/切换文件（如影随形） */
    OPEN_FILE = 'open_file',
    /** 远程新建/删除/重命名文件或文件夹 */
    FILE_EVENT = 'file_event'
}

// ---- 单个文本变更 ----
export interface TextChange {
    /** 变更的起始行号（0-based） */
    startLine: number;
    /** 变更的起始列号（0-based） */
    startChar: number;
    /** 变更的结束行号（0-based） */
    endLine: number;
    /** 变更的结束列号（0-based） */
    endChar: number;
    /** 替换的文本内容，空字符串表示删除 */
    text: string;
}

// ---- 文档变更消息 ----
export interface ChangeMessage {
    type: MessageType.CHANGE;
    /** 文件的相对路径（相对于工作区根目录） */
    filePath: string;
    /** 本次变更包含的所有增量修改 */
    changes: TextChange[];
    /** 发送者 ID */
    senderId: string;
}

// ---- 光标与选区同步消息 ----
export interface CursorMessage {
    type: MessageType.CURSOR;
    /** 文件的相对路径 */
    filePath: string;
    /** 选区列表 */
    selections: {
        anchorLine: number;
        anchorChar: number;
        activeLine: number;
        activeChar: number;
    }[];
    /** 发送者 ID */
    senderId: string;
}

// ---- 全文同步消息 ----
export interface FullSyncMessage {
    type: MessageType.FULL_SYNC;
    /** 文件的相对路径 */
    filePath: string;
    /** 文件的完整内容 */
    content: string;
}

// ---- 请求同步消息 ----
export interface RequestSyncMessage {
    type: MessageType.REQUEST_SYNC;
    /** 请求同步的文件路径 */
    filePath: string;
}

// ---- 通知消息 ----
export interface NotificationMessage {
    type: MessageType.NOTIFICATION;
    /** 通知内容 */
    message: string;
}

// ---- 工作区同步消息（发送多个文件，支持分批） ----
export interface WorkspaceSyncMessage {
    type: MessageType.WORKSPACE_SYNC;
    /** 本批次的文件列表和内容 */
    files: {
        filePath: string;
        content: string;
    }[];
    /** 当前批次索引（从 0 开始），缺省表示单批次 */
    batchIndex?: number;
    /** 总批次数，缺省表示单批次 */
    totalBatches?: number;
}

// ---- 远程代开文件消息 ----
export interface OpenFileMessage {
    type: MessageType.OPEN_FILE;
    /** 需要打开的文件相对路径 */
    filePath: string;
}

// ---- 文件(夹)系统事件消息 ----
export interface FileEventMessage {
    type: MessageType.FILE_EVENT;
    /** 事件类型：create新建, delete删除, rename重命名 */
    eventType: 'create' | 'delete' | 'rename';
    /** 目标文件相对路径（若是rename，则为旧路径） */
    filePath: string;
    /** 是否为文件夹 */
    isDir: boolean;
    /** 对于 rename 事件，此字段包含目标新路径 */
    newFilePath?: string;
    /** 发送者 ID，用于过滤自己发送的消息 */
    senderId: string;
}

/** 消息联合类型 */
export type ShareMessage =
    | ChangeMessage
    | FullSyncMessage
    | RequestSyncMessage
    | NotificationMessage
    | WorkspaceSyncMessage
    | OpenFileMessage
    | CursorMessage
    | FileEventMessage;
