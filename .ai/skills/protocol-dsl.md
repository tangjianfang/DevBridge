# Skill: Protocol DSL — 声明式协议描述系统

## Preconditions

当以下情况发生时激活本 skill：
- 用户定义新设备的通信协议（编写 protocol.schema.json）
- 涉及 Protocol DSL 的字段类型系统
- 用户调用 Protocol Runtime Engine 的 encode/decode
- 讨论校验算法配置（CRC/XOR/Checksum）
- 处理帧边界识别模式（framing 配置）
- 涉及 `IProtocol` 接口实现

---

## Instructions

### IProtocol 接口

```typescript
interface IProtocol {
  readonly name: string;
  readonly version: string;
  encode(command: string, params: Record<string, unknown>): Buffer;
  decode(buffer: Buffer): DecodedMessage;
  validate(buffer: Buffer): boolean; // 校验帧合法性（CRC 等）
  getChannelType(message: DecodedMessage): 'command' | 'event'; // 判断属于哪个通道
  getSupportedCommands(): string[];
}

interface DecodedMessage {
  messageType: string;
  fields: Record<string, unknown>;
  correlationId?: string;
  reportId?: number;
  characteristicUUID?: string;
  rawHex: string; // 调试用十六进制摘要
}
```

### Protocol Schema 完整结构

```typescript
interface ProtocolSchema {
  name: string;            // 协议唯一名称
  version: string;         // semver
  transport: string;       // 适用 transport 类型（可多选：'serial|usb-hid'）
  description?: string;

  framing: FramingConfig;          // 帧边界识别
  checksum?: ChecksumConfig;       // 校验算法（可选）
  channels: ChannelsConfig;        // 双通道定义
  commands?: Record<string, CommandDef>; // 命令字典
  examples: ExampleEntry[];        // 自测用例（必填）
}
```

### framing — 帧边界识别

```typescript
type FramingConfig =
  | { mode: 'delimiter';      delimiter: string }          // ASCII: "\r\n" | HEX: "0D0A"
  | { mode: 'magic-header';   header: string[]; lengthField?: LengthFieldDef }
  | { mode: 'length-prefix';  lengthOffset: number; lengthSize: 1|2|4; lengthIncludes: 'payload'|'all' }
  | { mode: 'fixed-length';   length: number }
  | { mode: 'modbus';         }                             // Modbus RTU 3.5字符间隔
  | { mode: 'inter-byte-timeout'; interval: number }        // ms，最通用 fallback
  | { mode: 'stateless' };                                  // 无固定帧（如 ESC/POS 打印流）
```

### 字段类型系统

```typescript
type FieldType =
  // 基础数值类型
  | 'uint8' | 'uint16le' | 'uint16be' | 'uint32le' | 'uint32be'
  | 'int8'  | 'int16le'  | 'int16be'  | 'int32le'  | 'int32be'
  | 'float32le' | 'float32be' | 'float64le' | 'float64be'
  // 字符串/编码
  | 'ascii' | 'utf8' | 'hex'
  // 特殊格式
  | 'bcd'      // BCD 编码数字（如称重仪的重量值）
  | 'bitmap'   // 位图，通过 bits 定义每位含义
  | 'bytes'    // 原始字节
  // 复合类型
  | 'enum'     // 枚举映射（value → label）
  | 'struct'   // 嵌套结构体
  | 'array'    // 重复字段
  | 'conditional'; // 条件字段（根据其他字段值决定结构）
```

### channels — 双通道字段定义

```typescript
interface ChannelsConfig {
  command?: {
    request:  { fields: FieldDef[] };
    response: { fields: FieldDef[] };
  };
  event?: {
    // 单一事件格式
    fields?: FieldDef[];
    // 多 Report ID / Characteristic UUID 路由
    routing?: 'reportId' | 'characteristicUUID' | 'fieldValue';
    routingField?: string;   // routing='fieldValue' 时使用的字段名
    reports?: Record<string, { messageType: string; fields: FieldDef[] }>;
    // BLE 多 Characteristic 数据聚合
    aggregation?: AggregationConfig;
  };
}
```

### 完整协议 Schema 示例（私有二进制帧协议）

```json
{
  "name": "my_sensor_v1",
  "version": "1.0.0",
  "transport": "serial",
  "description": "某品牌传感器私有二进制帧协议",
  "framing": {
    "mode": "magic-header",
    "header": ["0xAA", "0x55"],
    "lengthField": { "offset": 2, "size": 1, "includes": "payload" }
  },
  "checksum": {
    "algorithm": "xor",
    "range": "cmdCode..data",
    "position": "last-byte"
  },
  "channels": {
    "command": {
      "request": {
        "fields": [
          { "name": "header",   "type": "bytes", "value": ["0xAA", "0x55"], "length": 2 },
          { "name": "length",   "type": "uint8", "value": "auto" },
          { "name": "cmdCode",  "type": "uint8" },
          { "name": "data",     "type": "bytes", "length": "dynamic" },
          { "name": "checksum", "type": "uint8", "algorithm": "xor" }
        ]
      },
      "response": {
        "fields": [
          { "name": "header",   "type": "bytes", "length": 2 },
          { "name": "length",   "type": "uint8" },
          { "name": "status",   "type": "uint8", "enum": { "0": "OK", "1": "ERROR", "2": "BUSY" } },
          { "name": "data",     "type": "bytes", "length": "length - 2" },
          { "name": "checksum", "type": "uint8" }
        ]
      }
    },
    "event": {
      "routing": "fieldValue",
      "routingField": "eventCode",
      "reports": {
        "1": {
          "messageType": "TEMPERATURE_UPDATE",
          "fields": [
            { "name": "header",    "type": "bytes",   "length": 2 },
            { "name": "length",    "type": "uint8" },
            { "name": "eventCode", "type": "uint8" },
            { "name": "temp",      "type": "float32le", "unit": "celsius" },
            { "name": "checksum",  "type": "uint8" }
          ]
        }
      }
    }
  },
  "commands": {
    "GET_STATUS": { "cmdCode": "0x01", "dataFields": [] },
    "SET_MODE":   { "cmdCode": "0x02", "dataFields": [{ "name": "mode", "type": "uint8" }] },
    "RESET":      { "cmdCode": "0xFF", "dataFields": [] }
  },
  "examples": [
    {
      "direction": "send",
      "command": "GET_STATUS",
      "params": {},
      "hex": "AA 55 01 01 01",
      "description": "查询设备状态"
    },
    {
      "direction": "receive",
      "messageType": "GET_STATUS_RESPONSE",
      "hex": "AA 55 03 00 01 85 84",
      "decoded": { "status": "OK", "data": [1, 133], "checksum": 132 },
      "description": "设备状态响应：状态OK，电量 85%"
    }
  ]
}
```

### Protocol Runtime Engine

```typescript
class ProtocolRuntimeEngine {
  // 从 Schema JSON 生成 IProtocol 实例
  static compile(schema: ProtocolSchema): IProtocol {
    return new CompiledProtocol(schema);
  }
}

class CompiledProtocol implements IProtocol {
  readonly name: string;
  readonly version: string;

  constructor(private schema: ProtocolSchema) {
    this.name = schema.name;
    this.version = schema.version;
    // 运行 examples 自测（加载时验证）
    this.selfTest();
  }

  encode(command: string, params: Record<string, unknown>): Buffer {
    const cmdDef = this.schema.commands?.[command];
    if (!cmdDef) throw new Error(`PROTOCOL_UNKNOWN_COMMAND: ${command}`);
    // 按 channels.command.request.fields 顺序编码
    return this.encodeFields(this.schema.channels.command!.request.fields, params, cmdDef);
  }

  decode(buffer: Buffer): DecodedMessage {
    // 尝试 command response 解码
    // 如果不匹配，尝试 event 解码
    return this.decodeBuffer(buffer);
  }

  private selfTest(): void {
    for (const example of this.schema.examples) {
      const buf = Buffer.from(example.hex.replace(/\s/g, ''), 'hex');
      if (example.direction === 'send') {
        const encoded = this.encode(example.command!, example.params ?? {});
        if (!encoded.equals(buf)) {
          throw new Error(`PROTOCOL_SELFTEST_FAILED: encode mismatch for "${example.description}"`);
        }
      } else {
        const decoded = this.decode(buf);
        // 对比 decoded 与 example.decoded
      }
    }
  }
}
```

### 内置校验算法

```typescript
const CHECKSUM_ALGORITHMS: Record<string, (data: Buffer) => number> = {
  'xor':          (buf) => buf.reduce((acc, b) => acc ^ b, 0),
  'sum8':         (buf) => buf.reduce((acc, b) => (acc + b) & 0xFF, 0),
  'lrc':          (buf) => ((buf.reduce((acc, b) => acc + b, 0) ^ 0xFF) + 1) & 0xFF,
  'crc16-modbus': (buf) => crc16Modbus(buf),
  'crc16-ccitt':  (buf) => crc16CCITT(buf),
  'crc32':        (buf) => crc32(buf),
};
```

---

## Constraints

- 每个 Protocol Schema **必须**包含至少 1 个 `examples` 条目，且 examples 在加载时自动运行自测
- Schema 中的字段定义**必须**覆盖帧的每一个字节，不允许有"空洞"（未定义的字节区段）
- 不支持的复杂场景（多步握手、状态机、条件分支嵌套）用 `handler.ts` 的 `IProtocol` 代码实现，Schema 与 Code 协同
- Schema 语法错误**必须**在 `ProtocolRuntimeEngine.compile()` 时抛出，**禁止**静默失败
- `encode` 方法**禁止**修改输入参数对象（纯函数）
- Protocol 产出的 `rawHex` 字段在调试环境完整输出，生产环境截断为前 32 字节

---

## Examples

### Modbus RTU 读保持寄存器命令 Schema

```json
{
  "commands": {
    "READ_HOLDING_REGISTERS": {
      "cmdCode": "0x03",
      "dataFields": [
        { "name": "startAddr", "type": "uint16be" },
        { "name": "quantity",  "type": "uint16be" }
      ]
    }
  },
  "examples": [
    {
      "direction": "send",
      "command": "READ_HOLDING_REGISTERS",
      "params": { "address": 1, "startAddr": 0, "quantity": 2 },
      "hex": "01 03 00 00 00 02 C4 0B",
      "description": "从设备 1 读取地址 0 开始的 2 个保持寄存器"
    }
  ]
}
```
