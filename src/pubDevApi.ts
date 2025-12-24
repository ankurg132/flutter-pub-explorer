import * as https from 'https';

export interface PubPackage {
    name: string;
    latest: {
        version: string;
        pubspec: {
            name: string;
            version: string;
            description: string;
            homepage?: string;
            repository?: string;
        };
    };
}

export interface SearchResult {
    packages: Array<{
        package: string;
    }>;
    next?: string;
}

export interface PackageDetails {
    name: string;
    latest: {
        version: string;
        published?: string;
        pubspec: {
            name: string;
            version: string;
            description: string;
            homepage?: string;
            repository?: string;
            dependencies?: Record<string, any>;
            environment?: {
                sdk?: string;
                flutter?: string;
            };
        };
    };
    versions: Array<{
        version: string;
        published?: string;
    }>;
}

export interface PackageScore {
    grantedPoints: number;
    maxPoints: number;
    likeCount: number;
    downloadCount30Days: number;
    tags: string[];
}

export class PubDevApi {
    private readonly baseUrl = 'https://pub.dev/api';

    private fetch(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => resolve(data));
                res.on('error', reject);
            }).on('error', reject);
        });
    }

    async searchPackages(query: string, page: number = 1): Promise<SearchResult> {
        const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&page=${page}`;
        const response = await this.fetch(url);
        return JSON.parse(response);
    }

    async getPackageDetails(packageName: string): Promise<PackageDetails> {
        const url = `${this.baseUrl}/packages/${encodeURIComponent(packageName)}`;
        const response = await this.fetch(url);
        return JSON.parse(response);
    }

    async getPackageScore(packageName: string): Promise<PackageScore> {
        const url = `${this.baseUrl}/packages/${encodeURIComponent(packageName)}/score`;
        const response = await this.fetch(url);
        return JSON.parse(response);
    }

    async getPopularPackages(): Promise<SearchResult> {
        const url = `${this.baseUrl}/search?sort=popularity`;
        const response = await this.fetch(url);
        return JSON.parse(response);
    }

    async getFlutterPackages(page: number = 1): Promise<SearchResult> {
        const url = `${this.baseUrl}/search?q=sdk:flutter&page=${page}`;
        const response = await this.fetch(url);
        return JSON.parse(response);
    }

    getFlutterPubAddCommand(packageName: string, version?: string): string {
        if (version) {
            return `flutter pub add ${packageName}:${version}`;
        }
        return `flutter pub add ${packageName}`;
    }
}
