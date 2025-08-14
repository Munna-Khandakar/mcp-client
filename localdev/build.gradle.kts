import dev.ideascale.localdev.task.KubectlApplyManifest
import dev.ideascale.localdev.task.KubectlDeleteManifest

plugins {
    alias(i.plugins.helm.releases)
    alias(i.plugins.localdev)
}

helm {
    releases {
        create("mcp-client") {
            from(chart(project = ":app"))
            installDependsOn(":app:publish")
            fileValues.put("applicationEnv", layout.buildDirectory.file("config/properties/mcp-client.env"))
        }
    }
}
