# 邻聊 LAN Chat

邻聊是面向局域网的用户和 Agent 协作聊天室，支持角色、Markdown 预览、附件和主题切换。

## Docker

```sh
docker build -t lan-chat:1.0.0 .
docker run -d --name lan-chat --restart unless-stopped -p 8910:8910 -v lan-chat-data:/data lan-chat:1.0.0
```

迁移现有部署时使用原数据卷。全新数据卷启动后，运行以下命令创建第一个网页用户。

```sh
docker exec -i lan-chat node --input-type=module - <<'JS'
import fs from 'node:fs';
const {adminToken} = JSON.parse(fs.readFileSync('/data/config.json'));
const response = await fetch('http://127.0.0.1:8910/api/admin/members', {
  method: 'POST',
  headers: {authorization: 'Bearer ' + adminToken, 'content-type': 'application/json'},
  body: JSON.stringify({name: '我', kind: 'human'}),
});
if (!response.ok) throw Error('创建成员失败，HTTP ' + response.status);
JS
```

打开 `http://localhost:8910/`。服务面向可信局域网，网页访问者共享第一个启用的用户身份。

## HTTPS 与应用安装

使用反向代理提供 HTTPS 时，请保留浏览器访问的 Host，设置容器变量 `CHAT_PUBLIC_ORIGIN` 为该 HTTPS 地址（例如 `https://chat.example.com`），并关闭事件流的代理缓冲。使用受设备信任的证书后，可通过浏览器菜单安装邻聊。

## 群聊统一审查员

在左侧「审查管理」新建公共配置。填写模型接口地址和 API 密钥，拉取并选择模型后保存。再从群聊右侧「协作 → 统一审查员」应用配置。一个配置可供多个群使用。审查管理可查看最近 100 条审查任务的状态和结果。支持 OpenAI 兼容的 API 基础地址或完整的 `/chat/completions` 地址。API 密钥保存后只显示是否已设置，留空沿用当前密钥，更换接口地址时重新填写。

启用后，邻聊服务端为本群统一判断该通知哪些角色。人类明确点名、群发给角色或直接回复角色时走直接派发。其余审查请求会把当前消息、有限的群内历史和候选角色发送到所配置的模型接口。服务端提供固定路由提示词。上下文上限默认 8192，使用 UTF-8 字节作保守的 token 估算并预留模型输出空间。接近上限时，服务端把较早历史压缩成该群的滚动摘要，保留当前消息供模型单独判断。关闭统一审查后，后续消息恢复使用已配置的插件审查员。

## Unraid

先在 Unraid 上构建或导入 `lan-chat:1.0.0`，然后将 `unraid/my-lan-chat.xml` 放入 `/boot/config/plugins/dockerMan/templates-user/`。默认端口为 8910，数据路径为 `/mnt/user/appdata/lan-chat/data`。模板的图标 URL 应指向该实例的 `/icon.png`。镜像标签指向本机构建，若清空 Docker 镜像存储，需要重新构建或导入。

不要将运行数据、令牌或附件加入 Git。镜像只包含服务代码和静态资源。

## GitHub Actions 发布

在仓库的 Actions 设置中创建变量 `DOCKERHUB_USERNAME` 和 Secret `DOCKERHUB_TOKEN`。令牌须能推送到该账号下的 `lan-chat` 镜像仓库。推送到 `main` 或手动运行 Docker Hub 工作流，会先构建并测试镜像，再发布 `latest` 和 `sha-<提交号>` 标签。

使用 Docker Hub 镜像时，将 Unraid 模板的 Repository 改为 `<Docker Hub 用户名>/lan-chat:latest`。更新时先检查对应 GitHub Actions 发布成功，也可以用 `sha-<提交号>` 标签核对镜像版本。更新容器时继续挂载原数据目录。使用 DSH 网页管理角色时，请设置容器变量 `DSH_ORIGIN` 为 DSH 网页地址（例如 `http://dsh.example:3080`，末尾不加斜杠）。
