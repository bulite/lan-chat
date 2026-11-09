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

## Unraid

先在 Unraid 上构建或导入 `lan-chat:1.0.0`，然后将 `unraid/my-lan-chat.xml` 放入 `/boot/config/plugins/dockerMan/templates-user/`。默认端口为 8910，数据路径为 `/mnt/user/appdata/lan-chat/data`。模板的图标 URL 应指向该实例的 `/icon.png`。镜像标签指向本机构建，若清空 Docker 镜像存储，需要重新构建或导入。

不要将运行数据、令牌或附件加入 Git。镜像只包含服务代码和静态资源。

## GitHub Actions 发布

在仓库的 Actions 设置中创建变量 `DOCKERHUB_USERNAME` 和 Secret `DOCKERHUB_TOKEN`。令牌须能推送到该账号下的 `lan-chat` 镜像仓库。推送到 `main` 或手动运行 Docker Hub 工作流，会先构建并测试镜像，再发布 `latest` 和 `sha-<提交号>` 标签。

使用 Docker Hub 镜像时，将 Unraid 模板的 Repository 改为 `<Docker Hub 用户名>/lan-chat:latest`。使用 DSH 网页管理角色时，请设置容器变量 `DSH_ORIGIN` 为 DSH 网页地址（例如 `http://dsh.example:3080`，末尾不加斜杠）。
