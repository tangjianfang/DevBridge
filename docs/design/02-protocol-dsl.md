# 设计文档 02 — Protocol DSL

> **所属模块**: `packages/server/src/protocol/`  
> **线程模型**: 运行在 ProtocolEngine Worker Thread  
> **类型定义**: `packages/shared/src/types/protocol.d.ts`

---

## 1. 核心接口

### 1.1 IProtocol

```typescript
// packages/shared/src/types/protocol.d.ts

export interface DecodedMessage {
  channel:     'command-response' | 'event' | 'unknown';
  commandId?:  string;          // 匹配 Protocol Schema 中的命令名
  eventId?:    string;          // 匹配 Protocol Schema 中的事件名
  fields:      Record<string, unknown>;   // 解码后字段 key-value
  rawBuffer:   Buffer;          // 原始帧字节，方便调试
  timestamp:   number;          // decode 时刻 (Date.now())
  warnings?:   string[];        // 非致命警告（保留字段冗余等）
}

export interface IProtocol {
  readonly name:    string;     // 协议名称，等于 Schema 文件名（不含扩展名）
  readonly version: string;     // semver

  // 编解码
  encode(commandId: string, params: Record<string, unknown>): Buffer;
  decode(buffer: Buffer): DecodedMessage;
  validate(buffer: Buffer): boolean;

  // 元信息
  getChannelType(buffer: Buffer): DecodedMessage['channel'];
  getSupportedCommands(): string[];
  getSchema(): ProtocolSchema;
}
```

---

## 2. ProtocolSchema 完整类型

```typescript
export interface ProtocolSchema {
  name:        string;
  version:     string;
  description?: string;

  framing:     FramingConfig;       // 帧边界识别
  checksum?:   ChecksumConfig;      // 校验算法（可选）
  channels:    ChannelsConfig;      // Command / Event 通道配置
  commands:    CommandDef[];        // 支持的命令列表
  events:      EventDef[];          // 主动上报事件列表
  examples?:   ExampleEntry[];      // 往返测试样本
}

// ── 帧边界识别 ─────────────────────────────────────────────────────────────

export type FramingConfig =
  | { mode: 'delimiter';            start?: string; end: string }          // HEX 字节，如 "0A"
  | { mode: 'magic-header';         magic: string; lengthOffset: number; lengthSize: 1|2|4; littleEndian?: boolean }
  | { mode: 'length-prefix';        prefixSize: 1|2|4; includesPrefix?: boolean; littleEndian?: boolean }
  | { mode: 'fixed-length';         length: number }
  | { mode: 'modbus';               /* RTU: addr+func+data+CRC */ }
  | { mode: 'inter-byte-timeout';   timeoutMs: number }                    // 串口常用
  | { mode: 'stateless';            /* UDP 单帧即一条消息 */ };

// ── 校验算法 ────────────────────────────────────────────────────────────────

export type ChecksumConfig =
  | { type: 'xor';          range: 'header' | 'data' | 'full'; appendedBytes: 1 }
  | { type: 'crc16-modbus'; range: 'full';                      appendedBytes: 2 }
  | { type: 'crc8';         polynomial?: number;                appendedBytes: 1 }
  | { type: 'sum';          modulus?: number;                   appendedBytes: 1 }
  | { type: 'lrc';                                              appendedBytes: 1 };  // Modbus ASCII 专用

// ── 字段类型全集 ────────────────────────────────────────────────────────────

export type FieldType =
  | 'uint8'  | 'uint16-le' | 'uint16-be' | 'uint32-le' | 'uint32-be'
  | 'int8'   | 'int16-le'  | 'int16-be'  | 'int32-le'  | 'int32-be'
  | 'float-le' | 'float-be' | 'double-le' | 'double-be'
  | 'byte'   | 'bytes'
  | 'string-ascii' | 'string-utf8' | 'string-bcd' | 'bcd'
  | 'bool'
  | 'bitmap'                        // 按位解析（配合 bits 属性）
  | 'conditional'                   // 依赖前置字段值（配合 condition 属性）
  | 'struct'                        // 嵌套结构（配合 fields 属性）
  | 'array';                        // 重复结构（配合 count/countField 属性）

export interface FieldDef {
  name:         string;
  type:         FieldType;
  offset?:      number;             // 绝对偏移（固定结构使用）
  length?:      number;             // bytes
  lengthField?: string;             // 动态长度：引用前置字段名
  countField?:  string;             // array：引用前置字段名
  count?:       number;             // array：固定数量
  condition?:   string;             // conditional：JS 表达式字符串
  bits?:        BitField[];         // bitmap 专用
  fields?:      FieldDef[];         // struct / conditional 嵌套
  default?:     unknown;            // encode 时缺省值
  readonly?:    boolean;            // 只解码，不参与 encode
  description?: string;
}

export interface BitField {
  name:   string;
  bit:    number;
  type?:  'bool' | 'uint';
  width?: number;                   // 多位组合（type='uint' 时）
}

// ── 通道配置 ───────────────────────────────────────────────────────────────

export interface ChannelsConfig {
  command: {
    request: {
      fields: FieldDef[];
      commandIdField: string;       // 哪个字段携带命令 ID
    };
    response: {
      fields:         FieldDef[];
      commandIdField: string;       // 响应帧中标识对应命令的字段
      statusField?:   string;       // 可选：状态/错误码字段名
    };
  };
  event: {
    fields:       FieldDef[];
    eventIdField: string;           // 事件帧中标识事件类型的字段
  };
}

// ── 命令 / 事件定义 ─────────────────────────────────────────────────────────

export interface CommandDef {
  id:           string;             // 命令名，如 "GET_VERSION"
  requestCode:  number;             // commandIdField 的值
  description?: string;
  params?:      FieldDef[];         // 命令参数（覆盖 channels.command.request.fields）
  response?:    FieldDef[];         // 响应字段（覆盖 channels.command.response.fields）
}

export interface EventDef {
  id:           string;             // 事件名，如 "BUTTON_PRESSED"
  eventCode:    number;             // eventIdField 的值
  description?: string;
  fields?:      FieldDef[];         // 事件携带字段
}

// ── 往返测试样本 ────────────────────────────────────────────────────────────

export interface ExampleEntry {
  name:         string;
  direction:    'encode' | 'decode-command-response' | 'decode-event';
  input:        Record<string, unknown>;          // encode 时的 params
  expectedHex:  string;                          // HEX 字符串，不含空格
}
```

---

## 3. 运行时管道

### 3.1 解码管道（Decode Pipeline）

```
原始字节流（Buffer / ArrayBuffer）
         │
         ▼
┌─────────────────┐
│     Framer      │  按 FramingConfig 切帧
│  (frame splitter)│  → Buffer[]
└────────┬────────┘
         │ Buffer（单帧）
         ▼
┌─────────────────┐
│   Validator     │  校验 magic / checksum
│  (checksum/magic)│  → 无效帧 → 丢弃 + WARN
└────────┬────────┘
         │ Buffer（合法帧）
         ▼
┌─────────────────┐
│    Decoder      │  按 FieldDef 树解析字节
│  (field parser) │  支持 conditional / struct / array / bcd / bitmap
└────────┬────────┘
         │ DecodedMessage（channel + fields）
         ▼
┌─────────────────┐
│    Router       │  channel='command-response' → 命令响应队列
│  (channel router)│  channel='event'           → EventBus
└─────────────────┘
```

### 3.2 编码管道（Encode Pipeline）

```
commandId + params（Record<string, unknown>）
         │
         ▼
┌──────────────────────┐
│   FieldSerializer    │  遍历 FieldDef 树，将 JS 值序列化为字节
│  (type → bytes)      │  处理 default 填充、readonly 跳过
└──────────┬───────────┘
           │ Buffer（字段数据区）
           ▼
┌──────────────────────┐
│    FrameBuilder      │  拼 magic / length prefix / delimiter
│  (wrap headers)      │  -> Buffer（完整帧，不含校验）
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  ChecksumAppender    │  计算并追加校验字节（若 schema.checksum 存在）
└──────────────────────┘
           │ Buffer（最终帧）
           ▼
     transport.send()
```

---

## 4. 热重载机制

```
protocols/ 目录
      │  *.ts / *.json 文件变更
      ▼
 chokidar.watch()
      │ 触发 'change' 事件
      ▼
┌──────────────────────────────────────────┐
│  1. 读取新文件内容                        │
│  2. 在 sandboxedWorker 中:               │
│     a. esbuild 编译（带 sandbox plugin） │
│     b. 加载并执行 schema.examples[]      │
│        进行往返测试（encode→decode对比）  │
│     c. 若全部通过 → 返回新 IProtocol 实例│
│     d. 若失败     → 回滚 + 发送警告通知  │
│  3. ProtocolRegistry.atomicReplace()    │
│     用新实例原子替换旧实例               │
└──────────────────────────────────────────┘
      │ 发布 IPC: PROTOCOL_HOT_UPDATED
      ▼
 DeviceManager 接收 → 更新各 DeviceChannel
```

**往返测试（ExampleEntry）验证流程**：

```typescript
for (const ex of schema.examples ?? []) {
  if (ex.direction === 'encode') {
    const encoded = protocol.encode(ex.name, ex.input);
    assert(encoded.toString('hex') === ex.expectedHex.toLowerCase(),
      `Example '${ex.name}' encode mismatch`);
  } else {
    const buf     = Buffer.from(ex.expectedHex, 'hex');
    const decoded = protocol.decode(buf);
    for (const [k, v] of Object.entries(ex.input)) {
      assert.deepStrictEqual(decoded.fields[k], v,
        `Example '${ex.name}' decode field '${k}' mismatch`);
    }
  }
}
```

---

## 5. ProtocolRegistry

```typescript
// packages/server/src/protocol/protocol-registry.ts

export class ProtocolRegistry {
  private protocols = new Map<string, IProtocol>();
  private watcher?: FSWatcher;

  async loadFromFile(filePath: string): Promise<IProtocol> {
    const raw  = await fs.promises.readFile(filePath, 'utf-8');
    const schema: ProtocolSchema = this.parseSchema(raw, path.extname(filePath));
    const proto = new DynamicProtocol(schema);
    await this.runExamples(proto, schema.examples ?? []);
    this.protocols.set(schema.name, proto);
    return proto;
  }

  get(name: string): IProtocol {
    const p = this.protocols.get(name);
    if (!p) throw Object.assign(
      new Error(`PROTOCOL_NOT_FOUND: ${name}`),
      { errorCode: 'PROTOCOL_NOT_FOUND' }
    );
    return p;
  }

  list(): string[] { return [...this.protocols.keys()]; }

  atomicReplace(name: string, newProto: IProtocol): void {
    this.protocols.set(name, newProto);
  }

  startWatching(dir: string): void {
    this.watcher = chokidar.watch(path.join(dir, '**/*.{ts,json}'), {
      ignoreInitial: false, persistent: true
    });
    this.watcher.on('change', (filePath) => this.handleChange(filePath));
    this.watcher.on('add',    (filePath) => this.handleChange(filePath));
  }

  private async handleChange(filePath: string): Promise<void> {
    try {
      const proto = await this.loadFromFile(filePath);
      workerPort.postMessage({
        type: 'PROTOCOL_HOT_UPDATED', payload: { name: proto.name }
      } satisfies IPCMessage);
    } catch (err) {
      log.warn('Protocol hot-reload failed, keeping old version', { filePath, err });
      workerPort.postMessage({
        type: 'NOTIFICATION', severity: 'warning',
        payload: { message: `Protocol hot-reload failed: ${(err as Error).message}` }
      } satisfies IPCMessage);
    }
  }

  private parseSchema(content: string, ext: string): ProtocolSchema {
    if (ext === '.json') return JSON.parse(content) as ProtocolSchema;
    // TypeScript schema：esbuild 编译到 CJS 后 eval（sandbox 已在外层处理）
    throw new Error('TS schema must be processed via sandboxedWorker');
  }

  private async runExamples(
    proto:    IProtocol,
    examples: ExampleEntry[]
  ): Promise<void> { /* 见上方验证流程 */ }
}
```

---

## 6. DynamicProtocol 内部结构

```typescript
// packages/server/src/protocol/dynamic-protocol.ts

class DynamicProtocol implements IProtocol {
  readonly name:    string;
  readonly version: string;

  constructor(private schema: ProtocolSchema) {
    this.name    = schema.name;
    this.version = schema.version;
  }

  encode(commandId: string, params: Record<string, unknown>): Buffer {
    const cmd = this.schema.commands.find(c => c.id === commandId);
    if (!cmd) throw Object.assign(
      new Error(`PROTOCOL_COMMAND_NOT_FOUND: ${commandId}`),
      { errorCode: 'PROTOCOL_COMMAND_NOT_FOUND' }
    );
    const fields  = cmd.params ?? this.schema.channels.command.request.fields;
    const body    = FieldSerializer.serialize(fields, params);
    const framed  = FrameBuilder.wrap(body, this.schema.framing);
    return ChecksumAppender.append(framed, this.schema.checksum);
  }

  decode(buffer: Buffer): DecodedMessage {
    if (!this.validate(buffer)) {
      return { channel: 'unknown', fields: {}, rawBuffer: buffer,
               timestamp: Date.now(), warnings: ['INVALID_CHECKSUM'] };
    }
    const stripped = ChecksumAppender.strip(buffer, this.schema.checksum);
    const channel  = this.getChannelType(stripped);
    const chanDef  = channel === 'command-response'
      ? this.schema.channels.command.response
      : this.schema.channels.event;
    const fields   = FieldParser.parse(chanDef.fields, stripped);

    const commandId = channel === 'command-response'
      ? String(fields[this.schema.channels.command.response.commandIdField])
      : undefined;
    const eventId = channel === 'event'
      ? String(fields[this.schema.channels.event.eventIdField])
      : undefined;

    return { channel, commandId, eventId, fields, rawBuffer: buffer,
             timestamp: Date.now() };
  }

  validate(buffer: Buffer): boolean {
    return ChecksumAppender.verify(buffer, this.schema.checksum);
  }

  getChannelType(buffer: Buffer): DecodedMessage['channel'] {
    // 通过 eventIdField 是否能在 buffer 中解析出已知 eventCode 来判断
    // 默认：按 channels.command.response.commandIdField 解析，命中已知 commandId → command-response
    // 否则尝试 eventIdField，命中已知 eventCode → event，否则 unknown
    const maybeCmd = FieldParser.tryParseField(
      buffer, this.schema.channels.command.response.commandIdField,
      this.schema.channels.command.response.fields
    );
    if (maybeCmd !== undefined &&
        this.schema.commands.some(c => c.requestCode === maybeCmd)) {
      return 'command-response';
    }
    const maybeEvt = FieldParser.tryParseField(
      buffer, this.schema.channels.event.eventIdField,
      this.schema.channels.event.fields
    );
    if (maybeEvt !== undefined &&
        this.schema.events.some(e => e.eventCode === maybeEvt)) {
      return 'event';
    }
    return 'unknown';
  }

  getSupportedCommands(): string[]    { return this.schema.commands.map(c => c.id); }
  getSchema():            ProtocolSchema { return this.schema; }
}
```

---

## 7. 错误码全集 — PROTOCOL_*

| 错误码 | 触发场景 | HTTP 状态码 |
|--------|---------|-----------|
| `PROTOCOL_NOT_FOUND` | ProtocolRegistry.get() 未命中 | 404 |
| `PROTOCOL_PARSE_FAILED` | Schema JSON/TS 语法错误 | 400 |
| `PROTOCOL_CHECKSUM_FAILED` | 校验码与计算值不符 | 422 |
| `PROTOCOL_COMMAND_NOT_FOUND` | 请求未知 commandId | 400 |
| `PROTOCOL_DECODE_FAILED` | FieldParser 字节越界或类型不匹配 | 422 |
| `PROTOCOL_ENCODE_FAILED` | 必填字段缺失或值超出范围 | 400 |
| `PROTOCOL_EXAMPLE_FAILED` | 热重载时往返测试不通过 | 500 |
| `PROTOCOL_HOT_RELOAD_FAILED` | 编译或验证失败，已回滚 | 500 |

---

## 8. 测试要点

- **FramingConfig 全覆盖**：7 种 mode 各有对应的 fixture 字节流 + 切帧断言
- **ChecksumConfig 全覆盖**：5 种算法各有已知输入/校验码对
- **FieldType 关键类型**：bcd / bitmap / conditional / struct / array 各写 2 个用例
- **ExampleEntry 往返**：encode(params) → hex 匹配；hex → decode(fields) 对比
- **热重载回滚**：修改 Schema 注入错误往返样本，断言旧协议实例未被替换
- **decode 未知帧**：输入无法识别的字节，断言 channel='unknown'，不抛异常
