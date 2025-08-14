import com.github.gradle.node.npm.task.NpmTask
import org.gradle.kotlin.dsl.named

plugins {
    `maven-publish`
    alias(i.plugins.node)
    alias(i.plugins.docker)
    alias(i.plugins.helm)

    alias(i.plugins.convention.node)
    alias(i.plugins.convention.docker)
    alias(i.plugins.convention.helm)
}

npm {
    distDir.set(nodeDir)
}

helm {
    charts {
        create("main") {
            chartName = "mcp-client"
        }
    }
    filtering {
        values.put("imageRegistry", dockerImage.registry)
        values.put("imageRepository", dockerImage.repository)
        values.put("imageTag", project.version)
    }
}
