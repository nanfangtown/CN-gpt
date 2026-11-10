# Third-party notices

本包（`dsh-mm-models`）在 `minimax/` 目录与 `client.js` 的一个区块中，
内置了 **dsh-minimax-connect** 的代码。该部分版权归原作者所有，按 MIT 许可使用。

## dsh-minimax-connect

- 上游：https://github.com/VICqiufeeng/dsh-minimax-connect
- 版本：0.3.0
- 许可证：MIT
- 版权：Copyright (c) 2026 VICqiufeeng

### 合并时做的改动

1. 插件名 `minimax-connect` → `mm-minimax`（行 id 与设置命名空间同值）；
2. HTTP 路由前缀 `/plugins/dsh-minimax-connect/*` → `/plugins/dsh-mm-models/minimax/*`；
3. 客户端代码并入本包 `client.js`，不再占用 `plugins.bundle.config` 槽位
   （该槽位归本包自己的设置卡），其余渲染与交互不变；
4. 本机另修了签到按钮的两处行为（`claimableToday` 容错、按钮永远可点并按积分变化报结果），
   这部分不是上游 0.3.0 的行为。

除上述改动外，MiniMax 相关的凭据读取、OAuth 续期、模型目录解析、积分 / 签到 /
订阅额度读取逻辑均沿用上游实现。

### MIT License (upstream)

```
MIT License

Copyright (c) 2026 VICqiufeeng

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
