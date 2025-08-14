plugins {
    alias(i.plugins.helm) apply false
    alias(i.plugins.helm.releases) apply false
}

allprojects {

    group = "com.ideascale.mcp.client"
}

tasks.wrapper {
    gradleVersion = "8.13"
}
