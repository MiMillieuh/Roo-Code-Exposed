import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { ExtensionStateContextType } from "@/context/ExtensionStateContext"

interface WebServerSettingsProps extends HTMLAttributes<HTMLDivElement> {
	webServerPort?: number
	webServerPassword?: string
	setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType>
}

export const WebServerSettings = ({
	webServerPort,
	webServerPassword,
	setCachedStateField,
	...props
}: WebServerSettingsProps) => {
	const { t } = useAppTranslation()

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.webServer")}</SectionHeader>

			<Section>
				<div className="space-y-6">
					{/* Web Server Port Setting */}
					<SearchableSetting
						settingId="web-server-port"
						section="webServer"
						label={t("settings:webServer.port.label")}>
						<div className="flex flex-col gap-1">
							<span className="font-medium">{t("settings:webServer.port.label")}</span>
							<input
								type="number"
								min={1024}
								max={65535}
								className="w-32 px-2 py-1 rounded bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border focus:outline-none focus:border-vscode-focusBorder"
								value={webServerPort ?? 30000}
								onChange={(e) => {
									const val = parseInt(e.target.value, 10)
									if (!isNaN(val) && val >= 1024 && val <= 65535) {
										setCachedStateField("webServerPort", val)
									}
								}}
								data-testid="web-server-port-input"
							/>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:webServer.port.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Web Server Password Setting */}
					<SearchableSetting
						settingId="web-server-password"
						section="webServer"
						label={t("settings:webServer.password.label")}>
						<div className="flex flex-col gap-1">
							<span className="font-medium">{t("settings:webServer.password.label")}</span>
							<input
								type="password"
								className="w-64 px-2 py-1 rounded bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border focus:outline-none focus:border-vscode-focusBorder"
								value={webServerPassword ?? ""}
								placeholder={t("settings:webServer.password.placeholder")}
								onChange={(e) => setCachedStateField("webServerPassword", e.target.value || undefined)}
								data-testid="web-server-password-input"
							/>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:webServer.password.description")}
							</div>
						</div>
					</SearchableSetting>
				</div>
			</Section>
		</div>
	)
}
