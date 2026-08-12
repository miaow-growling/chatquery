#!/usr/bin/env python3
"""
PHP serialize/unserialize 工具 — 完全基于分隔符解析
容错 null 字节丢失、字符串长度不匹配等常见传输损坏问题。
用法: echo 'PHP_DATA' | python3 php_unserialize.py
      python3 php_unserialize.py file.txt
"""

import sys
import json
from io import BytesIO


class PHPObject:
    def __init__(self, class_name, properties):
        self.class_name = class_name
        self.properties = properties

    def __repr__(self):
        return f"PHPObject({self.class_name!r}, {self.properties!r}"


def _expect_byte(stream, expected_byte):
    b = stream.read(1)
    if not b or b[0] != expected_byte:
        pos = stream.tell() - 1
        raise ValueError(
            f"Expected {chr(expected_byte)!r} (0x{expected_byte:02x}), "
            f"got {b!r} at offset {pos}"
        )


def _parse_string_delimited(stream):
    """
    解析 s:LEN:"CONTENT";
    完全基于分隔符: 跳过 's' + ':LEN:' + 读到配对的 '"' + ';'
    """
    _expect_byte(stream, ord(':'))
    # 跳过长度数字
    while True:
        b = stream.read(1)
        if not b:
            raise ValueError("EOF in string length")
        if b[0] == ord(':'):
            break
    # 读引号
    _expect_byte(stream, ord('"'))
    # 读取内容直到非转义的引号
    content = bytearray()
    depth = 0
    while True:
        b = stream.read(1)
        if not b:
            raise ValueError("Unterminated string")
        if b[0] == ord('"') and depth == 0:
            break
        if b[0] == ord('\\'):
            # 转义: \\, \", \n, 等等
            nxt = stream.read(1)
            if not nxt:
                content.append(b[0])
                break
            if nxt[0] == ord('"'):
                content.append(ord('"'))
            elif nxt[0] == ord('\\'):
                content.append(ord('\\'))
            elif nxt[0] == ord('n'):
                content.append(ord('\n'))
            elif nxt[0] == ord('r'):
                content.append(ord('\r'))
            elif nxt[0] == ord('t'):
                content.append(ord('\t'))
            else:
                content.append(b[0])
                content.append(nxt[0])
        else:
            content.append(b[0])
    # 读分号
    _expect_byte(stream, ord(';'))
    return bytes(content).decode('utf-8', errors='replace')


def _parse_dict_content(stream):
    """解析 {key;value;key;value;...} — 读完 } 才返回"""
    result = {}
    while True:
        b = stream.read(1)
        if not b:
            raise ValueError("EOF in dict/object content")
        if b[0] == ord('}'):
            return result
        # 回退一个字节，让 _parse_value 处理
        stream.seek(-1, 1)
        key = _parse_value(stream)
        value = _parse_value(stream)
        result[key] = value


def _parse_value(stream):
    """递归解析一个 PHP 值（完全基于分隔符）"""
    tag = stream.read(1)
    if not tag:
        raise ValueError("Unexpected EOF")

    t = tag[0]

    # null: N;
    if t == ord('N'):
        _expect_byte(stream, ord(';'))
        return None

    # boolean: b:0; or b:1;
    if t == ord('b'):
        _expect_byte(stream, ord(':'))
        v = stream.read(1)[0]
        _expect_byte(stream, ord(';'))
        return v == ord('1')

    # integer: i:123;
    if t == ord('i'):
        _expect_byte(stream, ord(':'))
        num = bytearray()
        while True:
            b = stream.read(1)
            if not b:
                raise ValueError("EOF in int")
            if b[0] == ord(';'):
                break
            if b[0] in (ord('+'), ord('-')) or (ord('0') <= b[0] <= ord('9')):
                num.append(b[0])
        return int(num)

    # float: d:1.5;
    if t == ord('d'):
        _expect_byte(stream, ord(':'))
        num = bytearray()
        while True:
            b = stream.read(1)
            if not b:
                raise ValueError("EOF in float")
            if b[0] == ord(';'):
                break
            num.append(b[0])
        return float(num)

    # string: s:LEN:"CONTENT";
    if t == ord('s'):
        return _parse_string_delimited(stream)

    # array: a:COUNT:{key;value;...}
    if t == ord('a'):
        _expect_byte(stream, ord(':'))
        # skip count
        while True:
            b = stream.read(1)
            if not b:
                raise ValueError("EOF in array count")
            if b[0] == ord(':'):
                break
        _expect_byte(stream, ord('{'))
        result = _parse_dict_content(stream)
        return result

    # object: O:LEN:"CLASS":COUNT:{key;value;...}
    if t == ord('O'):
        _expect_byte(stream, ord(':'))
        # skip class name length
        while True:
            b = stream.read(1)
            if not b:
                raise ValueError("EOF in object class length")
            if b[0] == ord(':'):
                break
        _expect_byte(stream, ord('"'))
        # read class name (delimited)
        class_name = bytearray()
        while True:
            b = stream.read(1)
            if not b:
                raise ValueError("EOF in class name")
            if b[0] == ord('"'):
                break
            class_name.append(b[0])
        class_name = class_name.decode('utf-8', errors='replace')
        _expect_byte(stream, ord(':'))
        # skip property count
        while True:
            b = stream.read(1)
            if not b:
                raise ValueError("EOF in object prop count")
            if b[0] == ord(':'):
                break
        _expect_byte(stream, ord('{'))
        props = _parse_dict_content(stream)
        return PHPObject(class_name, props)

    raise ValueError(
        f"Unknown type tag: {chr(t)!r} (0x{t:02x}) at offset {stream.tell()-1}"
    )


def php_unserialize(data: bytes):
    stream = BytesIO(data)
    result = _parse_value(stream)
    remaining = stream.read().strip()
    if remaining:
        print(f"[warning] {len(remaining)} trailing bytes: {remaining[:80]!r}", file=sys.stderr)
    return result


def to_json_compatible(obj):
    if obj is None:
        return None
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, (int, float)):
        return obj
    if isinstance(obj, str):
        return obj
    if isinstance(obj, bytes):
        return obj.decode('utf-8', errors='replace')
    if isinstance(obj, PHPObject):
        return {"__php_class__": obj.class_name, "properties": to_json_compatible(obj.properties)}
    if isinstance(obj, dict):
        return {str(k): to_json_compatible(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_json_compatible(v) for v in obj]
    return str(obj)


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'rb') as f:
            data = f.read()
    else:
        if sys.stdin.isatty():
            print("Usage: echo 'PHP_DATA' | python3 php_unserialize.py", file=sys.stderr)
            print("       python3 php_unserialize.py file.txt", file=sys.stderr)
            sys.exit(1)
        data = sys.stdin.buffer.read()

    data = data.strip()
    if not data:
        print("No input data", file=sys.stderr)
        sys.exit(1)

    try:
        parsed = php_unserialize(data)
    except Exception as e:
        print(f"❌ Failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)

    result = to_json_compatible(parsed)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == '__main__':
    main()
