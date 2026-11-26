# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report privately through GitHub: go to the [Security tab](https://github.com/YihongGao/open-llm-translator/security) and click **Report a vulnerability**. Include the steps to reproduce, the affected version, and what an attacker could achieve.

You can expect an acknowledgement within 7 days. Once a fix is released, the advisory is published with credit to you unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## Scope

Examples of what we want to hear about:

- A way for a web page or another extension to read the API keys stored by the extension.
- Page content that makes the extension send data to anyone other than the provider the user selected, or send data from a tab where the user did not start a translation.
- Prompt injection that affects translations on a different site than the one containing the injected text, or that makes the extension do anything other than translate.
- Script execution in the extension's pages (popup, options) or through the translations it inserts into a page.

Out of scope: a page influencing how its own text is translated on that same site (a known limitation, see [docs/architecture.md](docs/architecture.md#hidden-text-filtering)), and issues in the LLM providers' own services.
