pluginManagement {
    repositories {
        maven {
            name = "GitHubPackages"
            url = uri("https://maven.pkg.github.com/ideascale/gradle")
            credentials {
                username = providers.gradleProperty("github.username").orNull ?: System.getenv("GITHUB_USERNAME")
                password = providers.gradleProperty("github.pat").orNull ?: System.getenv("GITHUB_PAT")
            }
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

plugins {
    id("dev.ideascale.settings") version "1.0.62"
}

rootProject.name = "mcp-client"

include("app")
